import type { FastifyInstance } from 'fastify';
import { AvailabilityQuery, type Slot } from '@app/contracts';
import { requireScope } from '../auth.ts';
import { ApiError } from '../errors.ts';
import { findAvailableSlots } from '../domain/availability.ts';
import { signSlotToken } from '../domain/slot-token.ts';
import { slotLabel } from '../domain/labels.ts';

const DEFAULT_WINDOW_DAYS = 21;
/** Pedido prioritário olha só os próximos dias: encaixe, não agenda cheia. */
const URGENT_WINDOW_DAYS = 3;
const URGENT_PRIORITY_THRESHOLD = 60;

export function registerAvailabilityRoutes(app: FastifyInstance): void {
  app.get('/availability', async (req) => {
    requireScope(req.principal, 'availability:read');
    const q = AvailabilityQuery.parse(req.query);
    const { config, db } = req.ctx;

    const tenant = await db.query<{ timezone: string }>(
      'SELECT timezone FROM tenants WHERE id = $1',
      [req.principal.tenantId],
    );
    const timezone = tenant.rows[0]?.timezone;
    if (!timezone) throw new ApiError('NOT_FOUND', 'Tenant não encontrado.');

    // A antecedência mínima evita oferecer um horário que começa em 10 minutos
    // para quem está mandando mensagem às 2h da manhã.
    const earliest = new Date(Date.now() + config.MIN_LEAD_TIME_MIN * 60_000);
    const from = q.from ? new Date(q.from) : earliest;
    const windowDays =
      q.priority >= URGENT_PRIORITY_THRESHOLD ? URGENT_WINDOW_DAYS : DEFAULT_WINDOW_DAYS;
    const to = q.to
      ? new Date(q.to)
      : new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000);

    if (to <= from) throw new ApiError('VALIDATION_FAILED', '`to` deve ser depois de `from`.');

    const raw = await findAvailableSlots(db, {
      tenantId: req.principal.tenantId,
      serviceId: q.service_id,
      priority: q.priority,
      from: from < earliest ? earliest : from,
      to,
      providerId: q.provider_id,
      period: q.period,
      weekdays: q.weekdays,
      limit: q.limit,
    });

    const tokenExpiry = Date.now() + config.SLOT_TOKEN_TTL_MIN * 60_000;
    const data: Slot[] = raw.map((s) => ({
      slot_id: signSlotToken(
        {
          t: req.principal.tenantId,
          p: s.provider_id,
          s: s.service_id,
          st: s.start.getTime(),
          en: s.end.getTime(),
          pr: s.required_priority,
          x: tokenExpiry,
        },
        config.SLOT_TOKEN_SECRET,
      ),
      provider: { id: s.provider_id, display_name: s.provider_name },
      service_id: s.service_id,
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      label_pt: slotLabel(s.start, timezone),
      is_reserved_window: s.is_reserved_window,
    }));

    return { data, generated_at: new Date().toISOString() };
  });
}
