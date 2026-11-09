import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createPool, type Db } from '../src/db/pool.ts';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/scheduling_test';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    SLOT_TOKEN_SECRET: 'test-slot-secret-0123456789',
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SUBJECT_PHONE_PEPPER: 'test-pepper-0123456789',
    LOG_LEVEL: 'silent',
    // Os testes semeiam a agenda em horários fixos no futuro.
    MIN_LEAD_TIME_MIN: '0',
    ...overrides,
  });
}

export async function setupDb(): Promise<Db> {
  await migrate(TEST_DB_URL);
  return createPool(TEST_DB_URL);
}

export async function resetDb(db: Db): Promise<void> {
  await db.query(`
    TRUNCATE tenants, providers, services, provider_services, working_hours,
             schedule_blocks, reserved_windows, subjects, conversations,
             appointments, slot_holds, outbox_events, idempotency_keys, audit_logs
    RESTART IDENTITY CASCADE
  `);
}

export function agentToken(tenantId: string, extra: string[] = []): string {
  const scopes = [
    'availability:read',
    'holds:write',
    'appointments:create',
    'appointments:read:own_conversation',
    'subjects:lookup',
    'subjects:create',
    ...extra,
  ].join(',');
  return `dev.service.agent.${tenantId}.${scopes}`;
}

export function staffToken(tenantId: string): string {
  return `dev.user.staff.${tenantId}.availability:read,appointments:read,appointments:update,appointments:create,holds:write,subjects:create,subjects:lookup,schedule:manage`;
}

/** Próxima data (a partir de amanhã) que cai num dia da semana ISO. */
export function nextWeekday(isoWeekday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (((d.getUTCDay() + 6) % 7) + 1 !== isoWeekday) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

export interface Seed {
  tenantId: string;
  providerId: string;
  serviceId: string;
  longServiceId: string;
  conversationId: string;
  subjectId: string;
}

/**
 * Clínica de teste: uma dentista, seg–sex 09:00–12:00 em America/Sao_Paulo,
 * serviço de 30 min com granularidade de 30 min (6 horários por dia).
 */
export async function seedClinic(db: Db): Promise<Seed> {
  const tenantId = 'tnt_test';
  const providerId = 'prc_ana';
  const serviceId = 'svc_avaliacao';
  const longServiceId = 'svc_canal';
  const conversationId = 'cnv_1';
  const subjectId = 'sub_1';

  await db.query(`INSERT INTO tenants (id, name, timezone) VALUES ($1, 'Clínica Teste', 'America/Sao_Paulo')`, [
    tenantId,
  ]);
  await db.query(`INSERT INTO providers (id, tenant_id, display_name) VALUES ($1, $2, 'Dra. Ana')`, [
    providerId,
    tenantId,
  ]);
  await db.query(
    `INSERT INTO services (id, tenant_id, code, name, duration_min, bookable_by_agent) VALUES
       ($1, $3, 'avaliacao', 'Avaliação', 30, true),
       ($2, $3, 'canal', 'Tratamento de canal', 90, false)`,
    [serviceId, longServiceId, tenantId],
  );
  await db.query(`INSERT INTO provider_services (provider_id, service_id) VALUES ($1, $2), ($1, $3)`, [
    providerId,
    serviceId,
    longServiceId,
  ]);
  for (let wd = 1; wd <= 5; wd++) {
    await db.query(
      `INSERT INTO working_hours (provider_id, weekday, start_time, end_time, slot_granularity_min)
       VALUES ($1, $2, '09:00', '12:00', 30)`,
      [providerId, wd],
    );
  }
  await db.query(
    `INSERT INTO subjects (id, tenant_id, full_name_enc, phone_hash) VALUES ($1, $2, '\\x00'::bytea, NULL)`,
    [subjectId, tenantId],
  );
  await db.query(
    `INSERT INTO conversations (id, tenant_id, subject_id) VALUES ($1, $2, $3)`,
    [conversationId, tenantId, subjectId],
  );

  return { tenantId, providerId, serviceId, longServiceId, conversationId, subjectId };
}

export function buildTestApp(db: Db, overrides: Record<string, string> = {}) {
  return buildApp(testConfig(overrides), db);
}
