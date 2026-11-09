import type { Db } from '../db/pool.ts';

export interface AvailabilityParams {
  tenantId: string;
  serviceId: string;
  priority: number;
  from: Date;
  to: Date;
  providerId?: string | undefined;
  period: 'manha' | 'tarde' | 'qualquer';
  weekdays?: number[] | undefined;
  limit: number;
}

export interface RawSlot {
  provider_id: string;
  provider_name: string;
  service_id: string;
  start: Date;
  end: Date;
  required_priority: number;
  is_reserved_window: boolean;
}

/**
 * A disponibilidade é calculada no servidor, em SQL, por três motivos:
 *
 * 1. O Postgres conhece o banco de fusos horários (horário de verão incluso),
 *    então "09:00 na segunda" vira o instante certo sem fazer conta na mão.
 * 2. A mesma consulta serve o agente e o painel: regra de negócio num lugar só.
 * 3. Sobreposição com agendamento, bloqueio e hold é resolvida com os índices
 *    GiST que já protegem a agenda.
 *
 * Um slot só entra no resultado se couber inteiro na jornada, não cruzar
 * bloqueio, agendamento ou hold vivo, e se o pedido tiver prioridade
 * suficiente para a janela em que cai.
 */
const SQL = /* sql */ `
WITH svc AS (
  SELECT s.id, s.duration_min, s.min_priority, s.bookable_by_agent, t.timezone
  FROM services s
  JOIN tenants  t ON t.id = s.tenant_id
  WHERE s.id = $1 AND s.tenant_id = $2 AND s.active
),
bounds AS (
  SELECT
    greatest($3::timestamptz, now()) AS from_ts,
    $4::timestamptz                  AS to_ts,
    (SELECT timezone FROM svc)       AS tz
),
days AS (
  SELECT d::date AS day
  FROM bounds b,
       generate_series(
         ((b.from_ts AT TIME ZONE b.tz)::date)::timestamp,
         ((b.to_ts   AT TIME ZONE b.tz)::date)::timestamp,
         interval '1 day'
       ) d
),
candidates AS (
  SELECT
    p.id                AS provider_id,
    p.display_name      AS provider_name,
    svc.id              AS service_id,
    ((d.day + wh.start_time) AT TIME ZONE b.tz)
      + (n * make_interval(mins => wh.slot_granularity_min)) AS start_ts,
    make_interval(mins => svc.duration_min)                  AS dur,
    ((d.day + wh.end_time) AT TIME ZONE b.tz)                AS day_end_ts
  FROM svc
  CROSS JOIN bounds b
  CROSS JOIN days d
  JOIN providers p
    ON p.tenant_id = $2 AND p.active
   AND ($5::text IS NULL OR p.id = $5::text)
  JOIN provider_services ps
    ON ps.provider_id = p.id AND ps.service_id = svc.id
  JOIN working_hours wh
    ON wh.provider_id = p.id
   AND wh.weekday = EXTRACT(ISODOW FROM d.day)::smallint
  CROSS JOIN LATERAL generate_series(
    0,
    greatest(
      0,
      floor(
        (EXTRACT(EPOCH FROM (wh.end_time - wh.start_time)) / 60 - svc.duration_min)
        / wh.slot_granularity_min
      )::int
    )
  ) AS n
  WHERE $6::int[] IS NULL
     OR EXTRACT(ISODOW FROM d.day)::int = ANY($6::int[])
),
slots AS (
  SELECT
    c.provider_id,
    c.provider_name,
    c.service_id,
    c.start_ts,
    c.start_ts + c.dur AS end_ts,
    tstzrange(c.start_ts, c.start_ts + c.dur, '[)') AS period
  FROM candidates c
  CROSS JOIN bounds b
  WHERE c.start_ts >= b.from_ts
    AND c.start_ts <  b.to_ts
    AND c.start_ts + c.dur <= c.day_end_ts
),
filtered AS (
  SELECT
    s.*,
    -- Maior exigência de prioridade entre as janelas reservadas que o slot
    -- toca. Zero quando o slot não cai em nenhuma.
    coalesce((
      SELECT max(rw.min_priority)
      FROM reserved_windows rw
      WHERE rw.provider_id = s.provider_id AND rw.period && s.period
    ), 0) AS required_priority
  FROM slots s
  WHERE NOT EXISTS (
          SELECT 1 FROM schedule_blocks sb
          WHERE sb.provider_id = s.provider_id AND sb.period && s.period
        )
    AND NOT EXISTS (
          SELECT 1 FROM appointments a
          WHERE a.provider_id = s.provider_id
            AND a.period && s.period
            AND a.status IN ('scheduled','confirmed','checked_in','completed')
        )
    AND NOT EXISTS (
          SELECT 1 FROM slot_holds h
          WHERE h.provider_id = s.provider_id
            AND h.period && s.period
            AND h.consumed_at IS NULL
            AND h.expires_at > now()
        )
)
SELECT
  f.provider_id,
  f.provider_name,
  f.service_id,
  f.start_ts  AS start,
  f.end_ts    AS "end",
  f.required_priority,
  (f.required_priority > 0) AS is_reserved_window
FROM filtered f
CROSS JOIN bounds b
WHERE f.required_priority <= $7::int
  AND (
    $8::text = 'qualquer'
    OR ($8::text = 'manha' AND EXTRACT(HOUR FROM (f.start_ts AT TIME ZONE b.tz)) <  12)
    OR ($8::text = 'tarde' AND EXTRACT(HOUR FROM (f.start_ts AT TIME ZONE b.tz)) >= 12)
  )
  AND $7::int >= (SELECT min_priority FROM svc)
ORDER BY f.start_ts, f.provider_id
LIMIT $9::int
`;

export async function findAvailableSlots(db: Db, p: AvailabilityParams): Promise<RawSlot[]> {
  const { rows } = await db.query<RawSlot>(SQL, [
    p.serviceId,
    p.tenantId,
    p.from.toISOString(),
    p.to.toISOString(),
    p.providerId ?? null,
    p.weekdays && p.weekdays.length > 0 ? p.weekdays : null,
    p.priority,
    p.period,
    p.limit,
  ]);
  return rows;
}
