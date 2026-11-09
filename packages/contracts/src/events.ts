import { z } from 'zod';
import { Id, IsoDateTime, Priority } from './common.js';

/**
 * Eventos publicados para o painel (SSE). Levam ids e metadados, nunca dado
 * clínico: o painel busca o detalhe via REST com o token do usuário, para que
 * RBAC e auditoria valham também no tempo real.
 */
export const EventType = z.enum([
  'appointment.created',
  'appointment.updated',
  'appointment.cancelled',
  'hold.created',
  'hold.expired',
  'classification.created',
  'emergency.alert',
  'handoff.created',
]);
export type EventType = z.infer<typeof EventType>;

export const OutboxEvent = z.object({
  id: Id,
  type: EventType,
  occurred_at: IsoDateTime,
  payload: z.record(z.unknown()),
});
export type OutboxEvent = z.infer<typeof OutboxEvent>;

export const AppointmentCreatedPayload = z.object({
  appointment_id: Id,
  provider_id: Id,
  service_id: Id,
  start: IsoDateTime,
  end: IsoDateTime,
  priority: Priority,
  source: z.string(),
});
export type AppointmentCreatedPayload = z.infer<typeof AppointmentCreatedPayload>;
