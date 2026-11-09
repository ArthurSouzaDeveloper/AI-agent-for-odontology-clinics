import Fastify, { type FastifyInstance } from 'fastify';
import {
  buildButtonsPayload,
  buildTextPayload,
  parseInbound,
  verifyMetaSignature,
  verifyWebhookChallenge,
  type InboundMessage,
} from './whatsapp.ts';
import { Responder, type BusinessConfig, type Reply } from './responder.ts';

/** Envia pela Graph API. Injetável para teste. */
export interface Sender {
  send(phoneNumberId: string, body: unknown): Promise<void>;
}

/** Guarda de deduplicação: a Meta reenvia webhooks. Em produção, Redis `SET NX EX`. */
export interface SeenStore {
  /** `true` se é a primeira vez que vemos este id. */
  firstTime(id: string): Promise<boolean>;
}

export interface HandoffNotifier {
  notify(info: { from: string; reason: string; lastMessage?: string }): Promise<void>;
}

export interface ServerDeps {
  appSecret: string;
  verifyToken: string;
  config: () => Promise<BusinessConfig>;
  sender: Sender;
  seen: SeenStore;
  notifier: HandoffNotifier;
  llm?: ConstructorParameters<typeof Responder>[1];
  now?: () => Date;
  /** Máximo de mensagens por cliente por janela, contra abuso e custo de LLM. */
  maxPerMinute?: number;
}

export class MemorySeenStore implements SeenStore {
  readonly #seen = new Map<string, number>();
  async firstTime(id: string): Promise<boolean> {
    const now = Date.now();
    for (const [k, t] of this.#seen) if (now - t > 24 * 3600_000) this.#seen.delete(k);
    if (this.#seen.has(id)) return false;
    this.#seen.set(id, now);
    return true;
  }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Telefone e texto do cliente não vão para log.
      redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]'],
    },
    bodyLimit: 512 * 1024,
  });

  // A assinatura é do corpo BRUTO: guardamos o buffer antes do parse do JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(null, null);
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/webhook', async (req, reply) => {
    const challenge = verifyWebhookChallenge(req.query as Record<string, string>, deps.verifyToken);
    return challenge === null ? reply.status(403).send('forbidden') : reply.type('text/plain').send(challenge);
  });

  const rate = new Map<string, number[]>();
  const limit = deps.maxPerMinute ?? 20;
  const tooMany = (from: string): boolean => {
    const now = Date.now();
    const recent = (rate.get(from) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    rate.set(from, recent);
    return recent.length > limit;
  };

  app.post('/webhook', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'];
    if (!raw || !verifyMetaSignature(raw, typeof signature === 'string' ? signature : undefined, deps.appSecret)) {
      return reply.status(401).send('invalid signature');
    }

    // Responde 200 já: a Meta reenvia se demorarmos. O processamento segue em
    // segundo plano, e a deduplicação protege contra o reenvio.
    const messages = parseInbound(req.body);
    void reply.status(200).send('ok');

    for (const m of messages) {
      handle(m).catch((err: unknown) => req.log.error({ err }, 'falha ao processar mensagem'));
    }
    return reply;
  });

  async function handle(m: InboundMessage): Promise<void> {
    if (!(await deps.seen.firstTime(m.id))) return;
    if (tooMany(m.from)) return;

    const now = deps.now?.() ?? new Date();
    const config = await deps.config();
    const responder = new Responder(config, deps.llm);

    let reply: Reply;
    if (m.kind === 'text') reply = await responder.reply({ text: m.text }, now);
    else if (m.kind === 'choice') reply = await responder.reply({ choiceId: m.choiceId, text: m.text }, now);
    else if (m.kind === 'audio') {
      // Transcrição de áudio entra na próxima fatia; até lá, pedimos texto.
      reply = {
        type: 'text',
        source: 'rule',
        text: 'Ainda não consigo ouvir áudios por aqui. Pode escrever sua dúvida? Se preferir, digite "atendente".',
      };
    } else {
      reply = {
        type: 'text',
        source: 'rule',
        text: 'Por aqui consigo entender só mensagens de texto. Pode escrever sua dúvida?',
      };
    }

    const body =
      reply.type === 'buttons'
        ? buildButtonsPayload(m.from, reply)
        : buildTextPayload(m.from, reply.text);
    await deps.sender.send(m.phoneNumberId, body);

    if (reply.type === 'handoff') {
      await deps.notifier.notify({
        from: m.from,
        reason: reply.reason,
        ...(m.kind === 'text' ? { lastMessage: m.text } : {}),
      });
    }
  }

  return app;
}
