import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CancelAppointmentRequest, CreateAppointmentRequest } from '@app/contracts';
import { requireConversation, requireScope } from '../auth.ts';
import { ApiError } from '../errors.ts';
import {
  cancelAppointment,
  createAppointmentFromHold,
  listConversationAppointments,
  loadAppointment,
} from '../domain/booking.ts';

export function registerAppointmentRoutes(app: FastifyInstance): void {
  app.post('/appointments', async (req, reply) => {
    requireScope(req.principal, 'appointments:create');
    const conversationId = requireConversation(req.principal);
    const body = CreateAppointmentRequest.parse(req.body);

    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 8) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'Header Idempotency-Key obrigatório (mínimo 8 caracteres).',
      );
    }

    const { appointment, replayed } = await createAppointmentFromHold(
      {
        db: req.ctx.db,
        slotTokenSecret: req.ctx.config.SLOT_TOKEN_SECRET,
        holdTtlMin: req.ctx.config.HOLD_TTL_MIN,
      },
      {
        tenantId: req.principal.tenantId,
        conversationId,
        holdId: body.hold_id,
        priority: body.priority,
        confirmationText: body.confirmation_text,
        classificationId: body.classification_id,
        notes: body.notes,
        source: req.principal.kind === 'service' ? 'whatsapp_agent' : 'dashboard',
        idempotencyKey: `${req.principal.tenantId}:${idempotencyKey.trim()}`,
      },
    );

    // A retentativa recebe 200 com o mesmo corpo: o agente não precisa saber
    // se foi a primeira chamada que venceu.
    return reply.status(replayed ? 200 : 201).send(appointment);
  });

  /** Lista os agendamentos futuros do paciente DAQUELA conversa, e só dele. */
  app.get('/conversations/:conversationId/appointments', async (req) => {
    requireScope(req.principal, 'appointments:read:own_conversation');
    const params = z.object({ conversationId: z.string().min(1) }).parse(req.params);
    const authorized = requireConversation(req.principal);
    if (params.conversationId !== authorized) {
      throw new ApiError(
        'CONVERSATION_SUBJECT_MISMATCH',
        'Token não autoriza o acesso a esta conversa.',
      );
    }
    const data = await listConversationAppointments(
      req.ctx.db,
      req.principal.tenantId,
      authorized,
    );
    return { data, next_cursor: null };
  });

  app.get('/appointments/:id', async (req) => {
    requireScope(req.principal, 'appointments:read');
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    return loadAppointment(req.ctx.db, req.principal.tenantId, id);
  });

  /** Agenda do painel: tudo num período, para a visão da doutora. */
  app.get('/appointments', async (req) => {
    requireScope(req.principal, 'appointments:read');
    const q = z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        provider_id: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(req.query);

    const statuses = q.status ? q.status.split(',') : ['scheduled', 'confirmed', 'checked_in'];

    const { rows } = await req.ctx.db.query<{ id: string }>(
      `SELECT id FROM appointments
        WHERE tenant_id = $1
          AND period && tstzrange($2, $3, '[)')
          AND ($4::text IS NULL OR provider_id = $4::text)
          AND status = ANY($5::text[])
        ORDER BY lower(period)
        LIMIT 500`,
      [req.principal.tenantId, q.from, q.to, q.provider_id ?? null, statuses],
    );

    const data = await Promise.all(
      rows.map((r) => loadAppointment(req.ctx.db, req.principal.tenantId, r.id)),
    );
    return { data, next_cursor: null };
  });

  app.post('/appointments/:id/cancel', async (req) => {
    requireScope(req.principal, 'appointments:update');
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = CancelAppointmentRequest.parse(req.body);
    return cancelAppointment(
      req.ctx.db,
      req.principal.tenantId,
      id,
      body.reason,
      body.cancelled_by,
    );
  });
}
