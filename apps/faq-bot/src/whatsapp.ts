import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Verifica o header `X-Hub-Signature-256` da Meta: HMAC-SHA256 do corpo BRUTO
 * (não do JSON reserializado) com o App Secret, comparado em tempo constante.
 * Sem isso qualquer pessoa na internet consegue "mandar mensagem" pelo bot.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GET de verificação do webhook (hub.challenge). */
export function verifyWebhookChallenge(
  query: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string },
  verifyToken: string,
): string | null {
  if (query['hub.mode'] !== 'subscribe' || !query['hub.verify_token'] || !query['hub.challenge']) return null;
  const a = Buffer.from(query['hub.verify_token']);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return query['hub.challenge'];
}

const Message = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
});

const WebhookPayload = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                messages: z.array(Message).optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type InboundMessage =
  | { kind: 'text'; id: string; from: string; phoneNumberId: string; text: string }
  | { kind: 'choice'; id: string; from: string; phoneNumberId: string; choiceId: string; text: string }
  | { kind: 'audio'; id: string; from: string; phoneNumberId: string; mediaId: string }
  | { kind: 'unsupported'; id: string; from: string; phoneNumberId: string; type: string };

/** Extrai só as mensagens recebidas; ignora status de entrega e leitura. */
export function parseInbound(payload: unknown): InboundMessage[] {
  const parsed = WebhookPayload.safeParse(payload);
  if (!parsed.success) return [];
  const out: InboundMessage[] = [];

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const phoneNumberId = change.value.metadata?.phone_number_id ?? '';
      for (const m of change.value.messages ?? []) {
        const base = { id: m.id, from: m.from, phoneNumberId };
        if (m.type === 'text' && m.text) out.push({ ...base, kind: 'text', text: m.text.body });
        else if (m.type === 'audio' && m.audio) out.push({ ...base, kind: 'audio', mediaId: m.audio.id });
        else if (m.type === 'interactive' && m.interactive) {
          const r = m.interactive.button_reply ?? m.interactive.list_reply;
          if (r) out.push({ ...base, kind: 'choice', choiceId: r.id, text: r.title });
          else out.push({ ...base, kind: 'unsupported', type: m.type });
        } else out.push({ ...base, kind: 'unsupported', type: m.type });
      }
    }
  }
  return out;
}

export interface OutboundButtons {
  text: string;
  buttons: Array<{ id: string; title: string }>;
}

/** Corpo da chamada `POST /{phone-number-id}/messages` da Graph API. */
export function buildTextPayload(to: string, text: string) {
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } };
}

export function buildButtonsPayload(to: string, msg: OutboundButtons) {
  if (msg.buttons.length < 1 || msg.buttons.length > 3) {
    throw new Error('O WhatsApp aceita de 1 a 3 botões de resposta.');
  }
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: msg.text },
      action: {
        buttons: msg.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })),
      },
    },
  };
}
