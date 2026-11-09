import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { buildServer, MemorySeenStore } from './server.ts';
import { BusinessConfig } from './responder.ts';
import { reiDoSuco } from './tenants/rei-do-suco.ts';
import { ClaudeFaqAnswerer } from './claude-answerer.ts';
import { GraphSender, WhatsAppOwnerNotifier } from './graph.ts';

const Env = z.object({
  PORT: z.coerce.number().int().default(3002),
  /** App Secret do app da Meta: valida a assinatura dos webhooks. */
  META_APP_SECRET: z.string().min(10),
  /** Token que você escolhe ao cadastrar o webhook no painel da Meta. */
  META_VERIFY_TOKEN: z.string().min(10),
  /** Token permanente (usuário do sistema) com permissão whatsapp_business_messaging. */
  META_ACCESS_TOKEN: z.string().min(10),
  META_PHONE_NUMBER_ID: z.string().regex(/^\d+$/),
  /** WhatsApp do dono em formato internacional sem "+", ex.: 5519999990000. */
  OWNER_WHATSAPP: z.string().regex(/^\d{10,15}$/),
  /** Sem esta chave o bot responde só por regras, FAQ e cardápio, e o resto vai para humano. */
  ANTHROPIC_API_KEY: z.string().optional(),
  FAQ_MODEL: z.string().default('claude-opus-5-5'),
  /** JSON com a configuração editada pelo dono. Sem ele, usa a configuração embutida. */
  BUSINESS_CONFIG_PATH: z.string().optional(),
  /** Opcional. Habilita POST /api/reply para Typebot/Leona (header Authorization: Bearer ...). */
  API_TOKEN: z.string().min(24).optional(),
});

const env = Env.parse(process.env);

/** Relê o arquivo a cada mensagem: o dono altera o horário e vale na hora, sem reiniciar. */
async function loadConfig(): Promise<BusinessConfig> {
  if (!env.BUSINESS_CONFIG_PATH) return reiDoSuco;
  return BusinessConfig.parse(JSON.parse(await readFile(env.BUSINESS_CONFIG_PATH, 'utf8')));
}

const sender = new GraphSender(env.META_ACCESS_TOKEN);
const initial = await loadConfig();

const app = buildServer({
  appSecret: env.META_APP_SECRET,
  verifyToken: env.META_VERIFY_TOKEN,
  config: loadConfig,
  sender,
  seen: new MemorySeenStore(),
  ...(env.API_TOKEN ? { apiToken: env.API_TOKEN } : {}),
  notifier: new WhatsAppOwnerNotifier(sender, env.META_PHONE_NUMBER_ID, env.OWNER_WHATSAPP),
  ...(env.ANTHROPIC_API_KEY
    ? { llm: new ClaudeFaqAnswerer({ businessName: initial.name, model: env.FAQ_MODEL }) }
    : {}),
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });
