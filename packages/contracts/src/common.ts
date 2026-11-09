import { z } from 'zod';

/**
 * Núcleo genérico (não-clínico).
 *
 * `priority` é a prioridade de atendimento do pedido, numa escala aberta
 * definida por tenant. A vertical odontológica mapeia seus níveis de urgência
 * nesta escala (ver `packages/triage-rules` e `tenants.config.priority_levels`):
 *
 *   EMERGENCIA     -> não agenda (hospital)
 *   URGENCIA       -> 100
 *   URGENCIA_LEVE  -> 60
 *   RETORNO        -> 30
 *   ROTINA         -> 10
 *
 * Uma barbearia pode usar só { normal: 10, encaixe: 60 }. O motor de agenda
 * não conhece nenhum desses nomes: ele só compara números e checa
 * `min_priority` das janelas reservadas.
 */
export const Priority = z.number().int().min(0).max(100);
export type Priority = z.infer<typeof Priority>;

export const Id = z.string().min(1).max(64);

export const IsoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 com offset, ex.: 2026-11-10T09:00:00-03:00');

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Period = z.enum(['manha', 'tarde', 'qualquer']);
export type Period = z.infer<typeof Period>;

/** 1 = segunda ... 7 = domingo (ISO-8601). */
export const Weekday = z.number().int().min(1).max(7);

export const Cursor = z.string().max(256);

export const Pagination = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
