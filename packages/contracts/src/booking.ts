import { z } from 'zod';
import { Id, IsoDateTime, Priority } from './common.js';

// ---------- Holds (reserva temporária) ----------

export const CreateHoldRequest = z.object({
  slot_id: z.string().min(1),
});
export type CreateHoldRequest = z.infer<typeof CreateHoldRequest>;

export const Hold = z.object({
  hold_id: Id,
  slot: z.object({
    provider_id: Id,
    service_id: Id,
    start: IsoDateTime,
    end: IsoDateTime,
  }),
  expires_at: IsoDateTime,
});
export type Hold = z.infer<typeof Hold>;

// ---------- Appointments ----------

export const AppointmentStatus = z.enum([
  'scheduled',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show',
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const AppointmentSource = z.enum(['whatsapp_agent', 'dashboard', 'import']);

/**
 * O agente cria a partir de um hold. `subject_id` (o paciente/cliente) NÃO vem
 * no corpo: a API o obtém da conversa autenticada, para que nem uma injeção de
 * prompt consiga agendar em nome de outra pessoa.
 */
export const CreateAppointmentRequest = z.object({
  hold_id: Id,
  priority: Priority.default(10),
  /** Trecho literal em que o cliente confirmou — fica na auditoria. */
  confirmation_text: z.string().max(500).optional(),
  /** Id da triagem/classificação que originou o pedido, quando houver. */
  classification_id: Id.optional(),
  notes: z.string().max(1000).optional(),
});
export type CreateAppointmentRequest = z.infer<typeof CreateAppointmentRequest>;

export const Appointment = z.object({
  id: Id,
  status: AppointmentStatus,
  provider: z.object({ id: Id, display_name: z.string() }),
  service: z.object({ id: Id, name: z.string(), duration_min: z.number().int() }),
  start: IsoDateTime,
  end: IsoDateTime,
  priority: Priority,
  source: AppointmentSource,
  location: z.object({ address: z.string().nullable() }).optional(),
  /** Pronto para a mensagem de confirmação, ex.: "terça, 10/11, às 9h00". */
  confirmation_label_pt: z.string(),
  version: z.number().int(),
});
export type Appointment = z.infer<typeof Appointment>;

export const CancelAppointmentRequest = z.object({
  reason: z.string().max(500),
  cancelled_by: z.enum(['subject', 'staff', 'agent']),
});
export type CancelAppointmentRequest = z.infer<typeof CancelAppointmentRequest>;

export const RescheduleAppointmentRequest = z.object({
  new_hold_id: Id,
});
export type RescheduleAppointmentRequest = z.infer<typeof RescheduleAppointmentRequest>;
