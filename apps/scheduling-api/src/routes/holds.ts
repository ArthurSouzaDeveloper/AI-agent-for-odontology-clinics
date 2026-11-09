import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateHoldRequest, Priority } from '@app/contracts';
import { requireConversation, requireScope } from '../auth.ts';
import { createHold, releaseHold } from '../domain/booking.ts';

const Body = CreateHoldRequest.extend({ priority: Priority.default(10) });

export function registerHoldRoutes(app: FastifyInstance): void {
  app.post('/slot-holds', async (req, reply) => {
    requireScope(req.principal, 'holds:write');
    const conversationId = requireConversation(req.principal);
    const body = Body.parse(req.body);

    const hold = await createHold(
      {
        db: req.ctx.db,
        slotTokenSecret: req.ctx.config.SLOT_TOKEN_SECRET,
        holdTtlMin: req.ctx.config.HOLD_TTL_MIN,
      },
      {
        tenantId: req.principal.tenantId,
        conversationId,
        slotId: body.slot_id,
        priority: body.priority,
        isAgent: req.principal.kind === 'service',
      },
    );

    return reply.status(201).send(hold);
  });

  app.delete('/slot-holds/:holdId', async (req, reply) => {
    requireScope(req.principal, 'holds:write');
    const conversationId = requireConversation(req.principal);
    const { holdId } = z.object({ holdId: z.string().min(1) }).parse(req.params);

    await releaseHold(req.ctx.db, req.principal.tenantId, conversationId, holdId);
    return reply.status(204).send();
  });
}
