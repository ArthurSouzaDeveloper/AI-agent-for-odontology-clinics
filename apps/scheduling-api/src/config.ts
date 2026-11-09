import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1),
  /** Assina os slot_id. Em produção vem do KMS/Secrets Manager. */
  SLOT_TOKEN_SECRET: z.string().min(16),
  SLOT_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(30),
  HOLD_TTL_MIN: z.coerce.number().int().positive().default(10),
  /** Não oferecer horário que comece antes de agora + este intervalo. */
  MIN_LEAD_TIME_MIN: z.coerce.number().int().min(0).default(60),
  /** Chave AES-256-GCM (32 bytes em base64). Em produção, via envelope KMS. */
  FIELD_ENCRYPTION_KEY: z.string().min(44),
  /** Pepper do HMAC de telefone. Fica fora do banco. */
  SUBJECT_PHONE_PEPPER: z.string().min(16),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida — ${issues}`);
  }
  return parsed.data;
}
