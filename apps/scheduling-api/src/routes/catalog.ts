import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth.ts';

export function registerCatalogRoutes(app: FastifyInstance): void {
  app.get('/providers', async (req) => {
    requireScope(req.principal, 'availability:read');
    const { rows } = await req.ctx.db.query(
      `SELECT id, display_name, specialties, active
         FROM providers WHERE tenant_id = $1 AND active ORDER BY display_name`,
      [req.principal.tenantId],
    );
    return { data: rows, next_cursor: null };
  });

  app.get('/services', async (req) => {
    requireScope(req.principal, 'availability:read');
    const { rows } = await req.ctx.db.query(
      `SELECT id, code, name, duration_min, min_priority, bookable_by_agent, active
         FROM services WHERE tenant_id = $1 AND active ORDER BY name`,
      [req.principal.tenantId],
    );
    return { data: rows, next_cursor: null };
  });

  /**
   * O agente usa isto para saber se a clínica está aberta agora e o que dizer
   * ("voltamos a atender às 8h"). O cálculo é do servidor, com o fuso do
   * tenant, para não depender do relógio do worker.
   */
  app.get('/clinic/business-hours', async (req) => {
    requireScope(req.principal, 'availability:read');
    const tenantId = req.principal.tenantId;

    const tenant = await req.ctx.db.query<{ timezone: string }>(
      'SELECT timezone FROM tenants WHERE id = $1',
      [tenantId],
    );
    const timezone = tenant.rows[0]?.timezone ?? 'America/Sao_Paulo';

    const weekly = await req.ctx.db.query<{
      weekday: number;
      start_time: string | null;
      end_time: string | null;
    }>(
      `SELECT wh.weekday,
              min(wh.start_time)::text AS start_time,
              max(wh.end_time)::text   AS end_time
         FROM working_hours wh
         JOIN providers p ON p.id = wh.provider_id
        WHERE p.tenant_id = $1 AND p.active
        GROUP BY wh.weekday
        ORDER BY wh.weekday`,
      [tenantId],
    );

    const openNow = await req.ctx.db.query<{ is_open: boolean; next_opening: Date | null }>(
      `WITH tz AS (SELECT timezone FROM tenants WHERE id = $1),
       local AS (SELECT (now() AT TIME ZONE (SELECT timezone FROM tz)) AS ts)
       SELECT
         EXISTS (
           SELECT 1 FROM working_hours wh
             JOIN providers p ON p.id = wh.provider_id
            WHERE p.tenant_id = $1 AND p.active
              AND wh.weekday = EXTRACT(ISODOW FROM (SELECT ts FROM local))::smallint
              AND (SELECT ts FROM local)::time BETWEEN wh.start_time AND wh.end_time
         ) AS is_open,
         (
           SELECT min(((d.day + wh.start_time) AT TIME ZONE (SELECT timezone FROM tz)))
             FROM generate_series(
                    ((SELECT ts FROM local))::date::timestamp,
                    ((SELECT ts FROM local))::date::timestamp + interval '8 days',
                    interval '1 day') d(day)
             JOIN working_hours wh
               ON wh.weekday = EXTRACT(ISODOW FROM d.day)::smallint
             JOIN providers p ON p.id = wh.provider_id AND p.tenant_id = $1 AND p.active
            WHERE ((d.day + wh.start_time) AT TIME ZONE (SELECT timezone FROM tz)) > now()
         ) AS next_opening`,
      [tenantId],
    );

    return {
      timezone,
      is_open_now: openNow.rows[0]?.is_open ?? false,
      next_opening: openNow.rows[0]?.next_opening?.toISOString() ?? null,
      weekly: weekly.rows,
    };
  });
}
