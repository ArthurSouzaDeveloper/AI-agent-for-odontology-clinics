import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/pool.ts';
import {
  agentToken,
  buildTestApp,
  nextWeekday,
  resetDb,
  seedClinic,
  setupDb,
  staffToken,
  type Seed,
} from './helpers.ts';

let db: Db;
let app: FastifyInstance;
let seed: Seed;

beforeAll(async () => {
  db = await setupDb();
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await resetDb(db);
  seed = await seedClinic(db);
  app = buildTestApp(db);
  await app.ready();
});

function headers(token: string, conversationId?: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...(conversationId ? { 'x-conversation-id': conversationId } : {}),
    ...extra,
  };
}

async function firstSlots(limit = 3, priority = 10, token = agentToken(seed.tenantId)) {
  const from = `${nextWeekday(2)}T00:00:00-03:00`;
  const to = `${nextWeekday(2)}T23:59:00-03:00`;
  const res = await app.inject({
    method: 'GET',
    url: `/v1/availability?service_id=${seed.serviceId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}&priority=${priority}`,
    headers: headers(token, seed.conversationId),
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Array<{ slot_id: string; start: string; label_pt: string }>;
}

async function hold(slotId: string, conversationId = seed.conversationId, priority = 10) {
  return app.inject({
    method: 'POST',
    url: '/v1/slot-holds',
    headers: headers(agentToken(seed.tenantId), conversationId),
    payload: { slot_id: slotId, priority },
  });
}

async function book(holdId: string, key = 'idem-key-0001', conversationId = seed.conversationId) {
  return app.inject({
    method: 'POST',
    url: '/v1/appointments',
    headers: headers(agentToken(seed.tenantId), conversationId, { 'idempotency-key': key }),
    payload: { hold_id: holdId, confirmation_text: 'pode confirmar sim' },
  });
}

describe('disponibilidade', () => {
  it('oferece os horários da jornada, em ordem, com rótulo em português e fuso do tenant', async () => {
    const slots = await firstSlots(10);

    // 09:00–12:00 com serviço de 30 min e passo de 30 min => 6 horários.
    expect(slots).toHaveLength(6);
    expect(slots[0]?.start).toBe(`${nextWeekday(2)}T12:00:00.000Z`); // 09:00 -03:00
    expect(slots[0]?.label_pt).toMatch(/^Ter, \d{2}\/\d{2} às 9h00$/);
    expect(slots[5]?.label_pt).toMatch(/às 11h30$/);
  });

  it('não oferece horário que já tem agendamento', async () => {
    const before = await firstSlots(10);
    const h = await hold(before[0]!.slot_id);
    await book((h.json() as { hold_id: string }).hold_id);

    const after = await firstSlots(10);
    expect(after).toHaveLength(5);
    expect(after.map((s) => s.start)).not.toContain(before[0]!.start);
  });

  it('não oferece horário de reserva (hold) ativa de outra conversa', async () => {
    const before = await firstSlots(10);
    await hold(before[0]!.slot_id);

    const after = await firstSlots(10);
    expect(after.map((s) => s.start)).not.toContain(before[0]!.start);
  });

  it('respeita bloqueios da agenda (almoço, férias)', async () => {
    const day = nextWeekday(2);
    await db.query(
      `INSERT INTO schedule_blocks (id, provider_id, period, reason)
       VALUES ('blk_1', $1, tstzrange($2, $3, '[)'), 'reunião')`,
      [seed.providerId, `${day}T10:00:00-03:00`, `${day}T11:00:00-03:00`],
    );

    const slots = await firstSlots(10);
    const labels = slots.map((s) => s.label_pt);
    expect(slots).toHaveLength(4);
    expect(labels.some((l) => l.endsWith('10h00') || l.endsWith('10h30'))).toBe(false);
  });

  it('guarda a janela de encaixe para pedidos de prioridade alta', async () => {
    const day = nextWeekday(2);
    await db.query(
      `INSERT INTO reserved_windows (id, provider_id, period, min_priority)
       VALUES ('rw_1', $1, tstzrange($2, $3, '[)'), 100)`,
      [seed.providerId, `${day}T11:00:00-03:00`, `${day}T12:00:00-03:00`],
    );

    const rotina = await firstSlots(10, 10);
    expect(rotina).toHaveLength(4); // 11h00 e 11h30 reservados

    const urgencia = await firstSlots(10, 100);
    expect(urgencia).toHaveLength(6);
    expect(urgencia.some((s) => s.label_pt.endsWith('11h00'))).toBe(true);
  });
});

describe('reserva e agendamento', () => {
  it('fluxo completo: oferta -> hold -> agendamento, com rótulo de confirmação e evento para o painel', async () => {
    const [slot] = await firstSlots(1);
    const h = await hold(slot!.slot_id);
    expect(h.statusCode).toBe(201);

    const res = await book((h.json() as { hold_id: string }).hold_id);
    expect(res.statusCode).toBe(201);

    const apt = res.json();
    expect(apt.status).toBe('scheduled');
    expect(apt.source).toBe('whatsapp_agent');
    expect(apt.confirmation_label_pt).toMatch(/^terça-feira, \d{2}\/\d{2}, às 9h00$/);
    expect(apt.provider.display_name).toBe('Dra. Ana');

    // O evento do painel foi gravado na MESMA transação do agendamento.
    const events = await db.query(`SELECT type, payload FROM outbox_events`);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].type).toBe('appointment.created');
    expect(events.rows[0].payload.appointment_id).toBe(apt.id);

    const audit = await db.query(`SELECT action FROM audit_logs WHERE entity_id = $1`, [apt.id]);
    expect(audit.rows[0].action).toBe('appointment.create');
  });

  it('retentativa com a mesma Idempotency-Key devolve o mesmo agendamento e não duplica', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;

    const first = await book(holdId, 'idem-retry-01');
    const second = await book(holdId, 'idem-retry-01');

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const count = await db.query(`SELECT count(*)::int AS n FROM appointments`);
    expect(count.rows[0].n).toBe(1);
    const events = await db.query(`SELECT count(*)::int AS n FROM outbox_events`);
    expect(events.rows[0].n).toBe(1);
  });

  it('a mesma chave com outro corpo é recusada', async () => {
    const [s1, s2] = await firstSlots(2);
    const h1 = ((await hold(s1!.slot_id)).json() as { hold_id: string }).hold_id;
    await book(h1, 'idem-reuse-01');

    const h2 = ((await hold(s2!.slot_id)).json() as { hold_id: string }).hold_id;
    const res = await book(h2, 'idem-reuse-01');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('exige Idempotency-Key', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: headers(agentToken(seed.tenantId), seed.conversationId),
      payload: { hold_id: holdId },
    });
    expect(res.statusCode).toBe(422);
  });

  it('um hold só pode virar um agendamento', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;

    expect((await book(holdId, 'idem-once-0001')).statusCode).toBe(201);
    const again = await book(holdId, 'idem-once-0002');
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('HOLD_ALREADY_USED');
  });

  it('hold expirado não vira agendamento', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;
    await db.query(`UPDATE slot_holds SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      holdId,
    ]);

    const res = await book(holdId);
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('HOLD_EXPIRED');
  });

  it('cancelar libera o horário de volta para a oferta', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;
    const apt = (await book(holdId)).json() as { id: string; start: string };

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/appointments/${apt.id}/cancel`,
      headers: headers(staffToken(seed.tenantId)),
      payload: { reason: 'paciente desistiu', cancelled_by: 'staff' },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('cancelled');

    const slots = await firstSlots(10);
    expect(slots.map((s) => s.start)).toContain(apt.start);
  });
});

describe('concorrência (a razão de existir a trava no banco)', () => {
  it('30 conversas disputando o MESMO horário: exatamente 1 agendamento', async () => {
    const [slot] = await firstSlots(1);

    // 30 conversas e 30 pacientes distintos.
    const N = 30;
    for (let i = 0; i < N; i++) {
      await db.query(`INSERT INTO subjects (id, tenant_id, full_name_enc) VALUES ($1, $2, '\\x00')`, [
        `sub_c${i}`,
        seed.tenantId,
      ]);
      await db.query(`INSERT INTO conversations (id, tenant_id, subject_id) VALUES ($1, $2, $3)`, [
        `cnv_c${i}`,
        seed.tenantId,
        `sub_c${i}`,
      ]);
    }

    const holds = await Promise.all(
      Array.from({ length: N }, (_, i) => hold(slot!.slot_id, `cnv_c${i}`)),
    );
    const won = holds.filter((r) => r.statusCode === 201);
    const lost = holds.filter((r) => r.statusCode === 409);

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(N - 1);
    expect(lost.every((r) => r.json().code === 'SLOT_TAKEN')).toBe(true);

    const rows = await db.query(`SELECT count(*)::int AS n FROM slot_holds`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('recepção e bot agendando o mesmo horário ao mesmo tempo: o banco recusa o segundo', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;

    // A recepção insere direto, sem passar por hold: simula outro caminho de
    // escrita (painel, script, importação). A trava de exclusão vale para todos.
    const start = new Date(slot!.start);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [botResult, staffResult] = await Promise.allSettled([
      book(holdId, 'idem-race-0001'),
      db.query(
        `INSERT INTO appointments (id, tenant_id, provider_id, service_id, subject_id, period, source)
         VALUES ('apt_staff', $1, $2, $3, $4, tstzrange($5, $6, '[)'), 'dashboard')`,
        [seed.tenantId, seed.providerId, seed.serviceId, seed.subjectId, start, end],
      ),
    ]);

    const botOk = botResult.status === 'fulfilled' && botResult.value.statusCode === 201;
    const staffOk = staffResult.status === 'fulfilled';
    expect([botOk, staffOk].filter(Boolean)).toHaveLength(1);

    const count = await db.query(
      `SELECT count(*)::int AS n FROM appointments WHERE status = 'scheduled'`,
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('retentativas simultâneas da mesma chave não geram duplicata', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;

    const results = await Promise.all(
      Array.from({ length: 8 }, () => book(holdId, 'idem-parallel-1')),
    );
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);

    const count = await db.query(`SELECT count(*)::int AS n FROM appointments`);
    expect(count.rows[0].n).toBe(1);
  });
});

describe('segurança do agente', () => {
  it('não aceita slot_id forjado', async () => {
    const [slot] = await firstSlots(1);
    const forged = slot!.slot_id.slice(0, -4) + 'AAAA';
    const res = await hold(forged);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SLOT_INVALID');
  });

  it('não aceita slot_id adulterado para outro horário', async () => {
    const [slot] = await firstSlots(1);
    const [body, mac] = slot!.slot_id.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
    payload.st += 3600_000;
    payload.en += 3600_000;
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;

    const res = await hold(tampered);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SLOT_INVALID');
  });

  it('pedido de rotina não consegue reservar horário de janela de encaixe, mesmo com o token em mãos', async () => {
    const day = nextWeekday(2);
    await db.query(
      `INSERT INTO reserved_windows (id, provider_id, period, min_priority)
       VALUES ('rw_1', $1, tstzrange($2, $3, '[)'), 100)`,
      [seed.providerId, `${day}T11:00:00-03:00`, `${day}T12:00:00-03:00`],
    );

    // Quem tem prioridade alta recebe o slot da janela...
    const urgent = await firstSlots(10, 100);
    const reserved = urgent.find((s) => s.label_pt.endsWith('11h00'))!;

    // ...mas se repassar esse token com prioridade de rotina, a API recusa.
    const res = await hold(reserved.slot_id, seed.conversationId, 10);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('PRIORITY_TOO_LOW_FOR_SLOT');
  });

  it('o agente não agenda serviço que não é agendável por ele', async () => {
    const from = `${nextWeekday(2)}T00:00:00-03:00`;
    const to = `${nextWeekday(2)}T23:59:00-03:00`;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability?service_id=${seed.longServiceId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=1`,
      headers: headers(agentToken(seed.tenantId), seed.conversationId),
    });
    const slot = res.json().data[0];
    expect(slot).toBeDefined();

    const held = await hold(slot.slot_id);
    expect(held.statusCode).toBe(422);
    expect(held.json().code).toBe('SERVICE_NOT_BOOKABLE_BY_AGENT');
  });

  it('o agendamento vai para o paciente da CONVERSA; o corpo da requisição não escolhe o paciente', async () => {
    await db.query(`INSERT INTO subjects (id, tenant_id, full_name_enc) VALUES ('sub_other', $1, '\\x00')`, [
      seed.tenantId,
    ]);
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: headers(agentToken(seed.tenantId), seed.conversationId, {
        'idempotency-key': 'idem-subject-1',
      }),
      payload: { hold_id: holdId, subject_id: 'sub_other' },
    });
    expect(res.statusCode).toBe(201);

    const row = await db.query(`SELECT subject_id FROM appointments`);
    expect(row.rows[0].subject_id).toBe(seed.subjectId);
  });

  it('uma conversa não consegue usar o hold de outra', async () => {
    await db.query(`INSERT INTO subjects (id, tenant_id, full_name_enc) VALUES ('sub_b', $1, '\\x00')`, [
      seed.tenantId,
    ]);
    await db.query(`INSERT INTO conversations (id, tenant_id, subject_id) VALUES ('cnv_b', $1, 'sub_b')`, [
      seed.tenantId,
    ]);

    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;

    const res = await book(holdId, 'idem-steal-0001', 'cnv_b');
    expect(res.statusCode).toBe(403);
  });

  it('listagem da conversa só devolve agendamentos do paciente vinculado a ela', async () => {
    const [slot] = await firstSlots(1);
    const holdId = ((await hold(slot!.slot_id)).json() as { hold_id: string }).hold_id;
    await book(holdId);

    await db.query(`INSERT INTO subjects (id, tenant_id, full_name_enc) VALUES ('sub_b', $1, '\\x00')`, [
      seed.tenantId,
    ]);
    await db.query(`INSERT INTO conversations (id, tenant_id, subject_id) VALUES ('cnv_b', $1, 'sub_b')`, [
      seed.tenantId,
    ]);

    const own = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${seed.conversationId}/appointments`,
      headers: headers(agentToken(seed.tenantId), seed.conversationId),
    });
    expect(own.json().data).toHaveLength(1);

    const other = await app.inject({
      method: 'GET',
      url: `/v1/conversations/cnv_b/appointments`,
      headers: headers(agentToken(seed.tenantId), 'cnv_b'),
    });
    expect(other.json().data).toHaveLength(0);

    // E não dá para ler a conversa dos outros trocando o id no path.
    const spoof = await app.inject({
      method: 'GET',
      url: `/v1/conversations/cnv_b/appointments`,
      headers: headers(agentToken(seed.tenantId), seed.conversationId),
    });
    expect(spoof.statusCode).toBe(403);
  });

  it('sem escopo, sem acesso', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability?service_id=${seed.serviceId}`,
      headers: headers(`dev.service.agent.${seed.tenantId}.holds:write`, seed.conversationId),
    });
    expect(res.statusCode).toBe(403);
  });

  it('sem token, 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/services' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('tenant não enxerga a agenda de outro tenant', async () => {
    await db.query(`INSERT INTO tenants (id, name) VALUES ('tnt_other', 'Outra')`);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability?service_id=${seed.serviceId}`,
      headers: headers(agentToken('tnt_other'), seed.conversationId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });
});
