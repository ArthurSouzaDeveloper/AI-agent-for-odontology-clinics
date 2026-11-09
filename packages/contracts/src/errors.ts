import { z } from 'zod';

/**
 * Códigos de erro estáveis. O agente de conversa decide o que fazer a partir
 * do `code`, nunca do texto, e nunca do status HTTP sozinho.
 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SLOT_TAKEN',
  'SLOT_INVALID',
  'SLOT_TOKEN_EXPIRED',
  'HOLD_EXPIRED',
  'HOLD_ALREADY_USED',
  'HOLD_LIMIT_REACHED',
  'SERVICE_NOT_BOOKABLE_BY_AGENT',
  'PRIORITY_TOO_LOW_FOR_SLOT',
  'CONVERSATION_SUBJECT_MISMATCH',
  'SUBJECT_ALREADY_BOOKED_SAME_DAY',
  'IDEMPOTENCY_KEY_REUSED',
  'VERSION_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 problem+json. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string().optional(),
  request_id: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SLOT_TAKEN: 409,
  SLOT_INVALID: 422,
  SLOT_TOKEN_EXPIRED: 410,
  HOLD_EXPIRED: 410,
  HOLD_ALREADY_USED: 409,
  HOLD_LIMIT_REACHED: 429,
  SERVICE_NOT_BOOKABLE_BY_AGENT: 422,
  PRIORITY_TOO_LOW_FOR_SLOT: 422,
  CONVERSATION_SUBJECT_MISMATCH: 403,
  SUBJECT_ALREADY_BOOKED_SAME_DAY: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  VERSION_MISMATCH: 412,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};
