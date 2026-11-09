import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Appointment, Hold } from '@app/contracts';
import { ApiError } from '../errors.ts';
import { isConstraintViolation, pgErrorCode, PG, withTx, type Db, type Tx } from '../db/pool.ts';
import { confirmationLabel } from './labels.ts';
import { verifySlotToken } from './slot-token.ts';

export interface BookingDeps {
  db: Db;
  slotTokenSecret: string;
  holdTtlMin: number;
}

// ------------------------------------------------------------------ holds

export interface CreateHoldInput {
  tenantId: string;
  conversationId: string;
  slotId: string;
  /** Prioridade do pedido (vem da classificação/triagem). */
  priority: number;
  /** `true` quando o chamador é o agente: respeita `bookable_by_agent`. */
  isAgent: boolean;
}

export async function createHold(deps: BookingDeps, input: CreateHoldInput): Promise<Hold> {
  const token = verifySlotToken(input.slotId, deps.slotTokenSecret);
  if (!token.ok) {
    throw token.reason === 'expired'
      ? new ApiError('SLOT_TOKEN_EXPIRED', 'A oferta de horário expirou. Busque novamente.')
      : new ApiError('SLOT_INVALID', 'Horário inválido.');
  }
  const slot = token.payload;

  if (slot.t !== input.tenantId) {
    throw new ApiError('SLOT_INVALID', 'Horário não pertence a este tenant.');
  }
  if (input.priority < slot.pr) {
    throw new ApiError(
      'PRIORITY_TOO_LOW_FOR_SLOT',
      'Este horário é reservado para pedidos de maior prioridade.',
    );
  }

  const start = new Date(slot.st);
  const end = new Date(slot.en);
  const expiresAt = new Date(Date.now() + deps.holdTtlMin * 60_000);

  return withTx(deps.db, async (tx) => {
    const svc = await tx.query<{ bookable_by_agent: boolean }>(
      'SELECT bookable_by_agent FROM services WHERE id = $1 AND tenant_id = $2 AND active',
      [slot.s, input.tenantId],
    );
    if (svc.rowCount === 0) throw new ApiError('NOT_FOUND', 'Serviço não encontrado.');
    if (input.isAgent && svc.rows[0]?.bookable_by_agent === false) {
      throw new ApiError(
        'SERVICE_NOT_BOOKABLE_BY_AGENT',
        'Este serviço não pode ser agendado pelo agente; agende uma avaliação.',
      );
    }

    // Um hold expirado continua ocupando a trava de exclusão (o predicado do
    // índice não pode chamar now()), então limpamos antes de inserir.
    await tx.query(
      `DELETE FROM slot_holds
        WHERE provider_id = $1 AND consumed_at IS NULL AND expires_at <= now()`,
      [slot.p],
    );

    // Numa conversa de WhatsApp o cliente troca de ideia: a reserva anterior
    // dele é liberada ao pedir outra, em vez de ficar segurando a agenda. Por
    // isso cada conversa tem no máximo uma reserva pendente por vez.
    await tx.query(
      `DELETE FROM slot_holds
        WHERE conversation_id = $1 AND consumed_at IS NULL`,
      [input.conversationId],
    );

    await assertSlotFree(tx, slot.p, start, end);

    const holdId = `hld_${ulid()}`;
    try {
      await tx.query(
        `INSERT INTO slot_holds
           (id, tenant_id, provider_id, service_id, conversation_id, period, priority, expires_at)
         VALUES ($1, $2, $3, $4, $5, tstzrange($6, $7, '[)'), $8, $9)`,
        [
          holdId,
          input.tenantId,
          slot.p,
          slot.s,
          input.conversationId,
          start.toISOString(),
          end.toISOString(),
          input.priority,
          expiresAt.toISOString(),
        ],
      );
    } catch (err) {
      if (pgErrorCode(err) === PG.EXCLUSION_VIOLATION) {
        throw new ApiError('SLOT_TAKEN', 'O horário acabou de ser reservado por outra pessoa.');
      }
      throw err;
    }

    return {
      hold_id: holdId,
      slot: {
        provider_id: slot.p,
        service_id: slot.s,
        start: start.toISOString(),
        end: end.toISOString(),
      },
      expires_at: expiresAt.toISOString(),
    };
  });
}

export async function releaseHold(
  db: Db,
  tenantId: string,
  conversationId: string,
  holdId: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `DELETE FROM slot_holds
      WHERE id = $1 AND tenant_id = $2 AND conversation_id = $3 AND consumed_at IS NULL`,
    [holdId, tenantId, conversationId],
  );
  if (rowCount === 0) throw new ApiError('NOT_FOUND', 'Reserva não encontrada.');
}

/**
 * Varredura periódica dos holds vencidos. A trava do banco já impede
 * overbooking; isto evita que um horário fique parecendo ocupado.
 */
export async function expireStaleHolds(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM slot_holds WHERE consumed_at IS NULL AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

async function assertSlotFree(tx: Tx, providerId: string, start: Date, end: Date): Promise<void> {
  const conflict = await tx.query(
    `SELECT 1
       FROM appointments
      WHERE provider_id = $1
        AND period && tstzrange($2, $3, '[)')
        AND status IN ('scheduled','confirmed','checked_in','completed')
      UNION ALL
     SELECT 1
       FROM schedule_blocks
      WHERE provider_id = $1
        AND period && tstzrange($2, $3, '[)')
      LIMIT 1`,
    [providerId, start.toISOString(), end.toISOString()],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    throw new ApiError('SLOT_TAKEN', 'O horário não está mais disponível.');
  }
}

// ------------------------------------------------------------ appointments

export interface CreateAppointmentInput {
  tenantId: string;
  conversationId: string;
  holdId: string;
  priority: number;
  confirmationText?: string | undefined;
  classificationId?: string | undefined;
  notes?: string | undefined;
  source: 'whatsapp_agent' | 'dashboard' | 'import';
  idempotencyKey: string;
}

export async function createAppointmentFromHold(
  deps: BookingDeps,
  input: CreateAppointmentInput,
): Promise<{ appointment: Appointment; replayed: boolean }> {
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({
        hold: input.holdId,
        conv: input.conversationId,
        priority: input.priority,
      }),
    )
    .digest('hex');

  return withTx(deps.db, async (tx) => {
    // A chave de idempotência é gravada primeiro, na mesma transação: uma
    // retentativa de rede do agente não cria um segundo agendamento.
    const claimed = await tx.query<{ status_code: number | null; response: unknown }>(
      `INSERT INTO idempotency_keys (key, tenant_id, route, request_hash)
            VALUES ($1, $2, 'POST /appointments', $3)
       ON CONFLICT (key) DO NOTHING
         RETURNING status_code, response`,
      [input.idempotencyKey, input.tenantId, requestHash],
    );

    if (claimed.rowCount === 0) {
      const existing = await tx.query<{
        request_hash: string;
        status_code: number | null;
        response: Appointment | null;
      }>(
        `SELECT request_hash, status_code, response FROM idempotency_keys
          WHERE key = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.idempotencyKey, input.tenantId],
      );
      const row = existing.rows[0];
      if (!row) throw new ApiError('INTERNAL', 'Falha ao resolver idempotência.');
      if (row.request_hash !== requestHash) {
        throw new ApiError(
          'IDEMPOTENCY_KEY_REUSED',
          'Esta chave de idempotência já foi usada com outro corpo.',
        );
      }
      if (row.response) return { appointment: row.response, replayed: true };
      // Primeira chamada ainda em voo: deixar o cliente tentar de novo é mais
      // seguro que agendar duas vezes.
      throw new ApiError('RATE_LIMITED', 'Requisição idêntica em andamento; tente novamente.');
    }

    const hold = await tx.query<{
      id: string;
      provider_id: string;
      service_id: string;
      conversation_id: string | null;
      start: Date;
      end: Date;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, provider_id, service_id, conversation_id,
              lower(period) AS start, upper(period) AS end, expires_at, consumed_at
         FROM slot_holds
        WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
      [input.holdId, input.tenantId],
    );
    const h = hold.rows[0];
    if (!h) throw new ApiError('NOT_FOUND', 'Reserva não encontrada.');
    if (h.consumed_at) throw new ApiError('HOLD_ALREADY_USED', 'Esta reserva já foi usada.');
    if (h.expires_at.getTime() <= Date.now()) {
      throw new ApiError('HOLD_EXPIRED', 'A reserva expirou. Busque os horários novamente.');
    }
    if (h.conversation_id !== input.conversationId) {
      throw new ApiError('FORBIDDEN', 'Esta reserva pertence a outra conversa.');
    }

    // Quem é o paciente vem da conversa, nunca do corpo da requisição.
    const conv = await tx.query<{ subject_id: string | null }>(
      'SELECT subject_id FROM conversations WHERE id = $1 AND tenant_id = $2',
      [input.conversationId, input.tenantId],
    );
    const subjectId = conv.rows[0]?.subject_id;
    if (conv.rowCount === 0) throw new ApiError('NOT_FOUND', 'Conversa não encontrada.');
    if (!subjectId) {
      throw new ApiError(
        'CONVERSATION_SUBJECT_MISMATCH',
        'A conversa ainda não está vinculada a um cadastro.',
      );
    }

    const appointmentId = `apt_${ulid()}`;
    try {
      await tx.query(
        `INSERT INTO appointments
           (id, tenant_id, provider_id, service_id, subject_id, conversation_id,
            period, status, priority, source, classification_id, confirmation_text, notes)
         VALUES ($1, $2, $3, $4, $5, $6, tstzrange($7, $8, '[)'),
                 'scheduled', $9, $10, $11, $12, $13)`,
        [
          appointmentId,
          input.tenantId,
          h.provider_id,
          h.service_id,
          subjectId,
          input.conversationId,
          h.start.toISOString(),
          h.end.toISOString(),
          input.priority,
          input.source,
          input.classificationId ?? null,
          input.confirmationText ?? null,
          input.notes ?? null,
        ],
      );
    } catch (err) {
      if (
        pgErrorCode(err) === PG.EXCLUSION_VIOLATION ||
        isConstraintViolation(err, 'appointments_no_overlap')
      ) {
        throw new ApiError('SLOT_TAKEN', 'O horário acabou de ser preenchido.');
      }
      throw err;
    }

    await tx.query(
      `UPDATE slot_holds SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
      [h.id],
    );

    const appointment = await loadAppointment(tx, input.tenantId, appointmentId);

    // Mesmo COMMIT do agendamento: não existe "salvou e não avisou o painel".
    await tx.query(
      `INSERT INTO outbox_events (tenant_id, type, payload)
            VALUES ($1, 'appointment.created', $2::jsonb)`,
      [
        input.tenantId,
        JSON.stringify({
          appointment_id: appointmentId,
          provider_id: h.provider_id,
          service_id: h.service_id,
          start: h.start.toISOString(),
          end: h.end.toISOString(),
          priority: input.priority,
          source: input.source,
        }),
      ],
    );

    await tx.query(
      `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity, entity_id)
            VALUES ($1, 'service', $2, 'appointment.create', 'appointment', $3)`,
      [input.tenantId, input.source, appointmentId],
    );

    await tx.query(
      `UPDATE idempotency_keys SET status_code = 201, response = $2::jsonb WHERE key = $1`,
      [input.idempotencyKey, JSON.stringify(appointment)],
    );

    return { appointment, replayed: false };
  });
}

export async function loadAppointment(
  tx: Tx | Db,
  tenantId: string,
  appointmentId: string,
): Promise<Appointment> {
  const { rows } = await tx.query<{
    id: string;
    status: Appointment['status'];
    provider_id: string;
    provider_name: string;
    service_id: string;
    service_name: string;
    duration_min: number;
    start: Date;
    end: Date;
    priority: number;
    source: Appointment['source'];
    version: number;
    timezone: string;
  }>(
    `SELECT a.id, a.status, a.priority, a.source, a.version,
            a.provider_id, p.display_name AS provider_name,
            a.service_id, s.name AS service_name, s.duration_min,
            lower(a.period) AS start, upper(a.period) AS end,
            t.timezone
       FROM appointments a
       JOIN providers p ON p.id = a.provider_id
       JOIN services  s ON s.id = a.service_id
       JOIN tenants   t ON t.id = a.tenant_id
      WHERE a.id = $1 AND a.tenant_id = $2`,
    [appointmentId, tenantId],
  );
  const r = rows[0];
  if (!r) throw new ApiError('NOT_FOUND', 'Agendamento não encontrado.');

  return {
    id: r.id,
    status: r.status,
    provider: { id: r.provider_id, display_name: r.provider_name },
    service: { id: r.service_id, name: r.service_name, duration_min: r.duration_min },
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    priority: r.priority,
    source: r.source,
    confirmation_label_pt: confirmationLabel(r.start, r.timezone),
    version: r.version,
  };
}

export async function cancelAppointment(
  db: Db,
  tenantId: string,
  appointmentId: string,
  reason: string,
  cancelledBy: string,
): Promise<Appointment> {
  return withTx(db, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND tenant_id = $2
          AND status IN ('scheduled','confirmed')`,
      [appointmentId, tenantId, reason],
    );
    if (rowCount === 0) {
      throw new ApiError('NOT_FOUND', 'Agendamento não encontrado ou já encerrado.');
    }

    await tx.query(
      `INSERT INTO outbox_events (tenant_id, type, payload)
            VALUES ($1, 'appointment.cancelled', $2::jsonb)`,
      [tenantId, JSON.stringify({ appointment_id: appointmentId, cancelled_by: cancelledBy })],
    );
    await tx.query(
      `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, entity, entity_id)
            VALUES ($1, 'service', $2, 'appointment.cancel', 'appointment', $3)`,
      [tenantId, cancelledBy, appointmentId],
    );

    return loadAppointment(tx, tenantId, appointmentId);
  });
}

/** Agendamentos futuros do paciente vinculado à conversa — e só dele. */
export async function listConversationAppointments(
  db: Db,
  tenantId: string,
  conversationId: string,
): Promise<Appointment[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id
       FROM appointments a
       JOIN conversations c ON c.subject_id = a.subject_id
      WHERE c.id = $1 AND c.tenant_id = $2 AND a.tenant_id = $2
        AND upper(a.period) > now()
        AND a.status IN ('scheduled','confirmed')
      ORDER BY lower(a.period)
      LIMIT 20`,
    [conversationId, tenantId],
  );
  return Promise.all(rows.map((r) => loadAppointment(db, tenantId, r.id)));
}
