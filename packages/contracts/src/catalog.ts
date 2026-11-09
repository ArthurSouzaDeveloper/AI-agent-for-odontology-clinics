import { z } from 'zod';
import { Id, Priority, Weekday } from './common.js';

/** Quem (ou o que) presta o serviço: dentista, barbeiro, veterinário, cadeira, sala. */
export const Provider = z.object({
  id: Id,
  display_name: z.string(),
  specialties: z.array(z.string()).default([]),
  active: z.boolean(),
});
export type Provider = z.infer<typeof Provider>;

export const Service = z.object({
  id: Id,
  code: z.string(),
  name: z.string(),
  duration_min: z.number().int().positive(),
  /** Prioridade mínima que o pedido precisa ter para este serviço ser oferecido. */
  min_priority: Priority.default(0),
  /** Serviços longos (canal, cirurgia) ficam `false`: o agente marca avaliação. */
  bookable_by_agent: z.boolean(),
  active: z.boolean(),
});
export type Service = z.infer<typeof Service>;

export const WorkingHours = z.object({
  weekday: Weekday,
  start_time: z.string().regex(/^\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}$/),
  slot_granularity_min: z.number().int().positive().default(15),
});
export type WorkingHours = z.infer<typeof WorkingHours>;

export const BusinessHours = z.object({
  timezone: z.string(),
  is_open_now: z.boolean(),
  next_opening: z.string().nullable(),
  weekly: z.array(
    z.object({
      weekday: Weekday,
      start_time: z.string().nullable(),
      end_time: z.string().nullable(),
    }),
  ),
});
export type BusinessHours = z.infer<typeof BusinessHours>;
