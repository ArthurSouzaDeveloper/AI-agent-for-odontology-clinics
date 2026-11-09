import { z } from 'zod';
import { Id, IsoDateTime, Period, Priority, Weekday } from './common.js';

export const AvailabilityQuery = z.object({
  service_id: Id,
  priority: z.coerce.number().int().min(0).max(100).default(10),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  provider_id: Id.optional(),
  period: Period.default('qualquer'),
  /** `?weekdays=2,4` */
  weekdays: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === ''
        ? undefined
        : v.split(',').map((n) => Weekday.parse(Number(n.trim()))),
    ),
  limit: z.coerce.number().int().min(1).max(20).default(3),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;

export const Slot = z.object({
  /** Token assinado (HMAC). O agente não consegue inventar um slot. */
  slot_id: z.string(),
  provider: z.object({ id: Id, display_name: z.string() }),
  service_id: Id,
  start: IsoDateTime,
  end: IsoDateTime,
  /** Rótulo pronto para o paciente, ex.: "Ter, 10/11 às 9h00". */
  label_pt: z.string(),
  is_reserved_window: z.boolean(),
});
export type Slot = z.infer<typeof Slot>;

export const AvailabilityResponse = z.object({
  data: z.array(Slot),
  generated_at: IsoDateTime,
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponse>;

/** Conteúdo assinado dentro de `slot_id`. */
export const SlotTokenPayload = z.object({
  t: Id.describe('tenant_id'),
  p: Id.describe('provider_id'),
  s: Id.describe('service_id'),
  st: z.number().int().describe('start, epoch ms'),
  en: z.number().int().describe('end, epoch ms'),
  pr: Priority.describe('prioridade mínima exigida pela janela'),
  x: z.number().int().describe('expira em, epoch ms'),
});
export type SlotTokenPayload = z.infer<typeof SlotTokenPayload>;
