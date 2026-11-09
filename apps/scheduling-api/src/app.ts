import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import { ApiError, toProblem } from './errors.ts';
import { authenticate, type Principal } from './auth.ts';
import { createPool, type Db } from './db/pool.ts';
import { FieldCrypto } from './domain/field-crypto.ts';
import { registerCatalogRoutes } from './routes/catalog.ts';
import { registerAvailabilityRoutes } from './routes/availability.ts';
import { registerHoldRoutes } from './routes/holds.ts';
import { registerAppointmentRoutes } from './routes/appointments.ts';
import { registerSubjectRoutes } from './routes/subjects.ts';
import { registerEventRoutes } from './routes/events.ts';

export interface AppContext {
  config: Config;
  db: Db;
  crypto: FieldCrypto;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
    ctx: AppContext;
  }
}

export function buildApp(config: Config, db?: Db): FastifyInstance {
  const pool = db ?? createPool(config.DATABASE_URL);
  const ctx: AppContext = {
    config,
    db: pool,
    crypto: new FieldCrypto(config.FIELD_ENCRYPTION_KEY, config.SUBJECT_PHONE_PEPPER),
  };

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Nada de conteúdo de mensagem, nome ou telefone em log.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.phone_e164',
          'req.body.full_name',
          'req.body.birth_date',
          'req.body.guardian_name',
          'req.body.confirmation_text',
          'req.body.notes',
        ],
        censor: '[redigido]',
      },
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    bodyLimit: 256 * 1024,
  });

  app.decorateRequest('principal');
  app.decorateRequest('ctx');

  app.addHook('onRequest', async (req, reply) => {
    req.ctx = ctx;
    reply.header('x-request-id', req.id);
  });

  // /health é a única rota sem autenticação.
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/health')) return;
    req.principal = authenticate(req, config.NODE_ENV);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) req.log.error({ err }, 'erro interno');
      return reply
        .status(err.status)
        .type('application/problem+json')
        .send(toProblem(err, String(req.id)));
    }
    if (err instanceof ZodError) {
      const apiErr = new ApiError(
        'VALIDATION_FAILED',
        'Corpo ou parâmetros inválidos.',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
      return reply
        .status(apiErr.status)
        .type('application/problem+json')
        .send(toProblem(apiErr, String(req.id)));
    }
    req.log.error({ err }, 'erro não tratado');
    // O cliente nunca recebe stack trace nem mensagem do Postgres.
    return reply
      .status(500)
      .type('application/problem+json')
      .send(toProblem(new ApiError('INTERNAL', 'Erro interno.'), String(req.id)));
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  const v1 = async (instance: FastifyInstance) => {
    registerCatalogRoutes(instance);
    registerAvailabilityRoutes(instance);
    registerHoldRoutes(instance);
    registerAppointmentRoutes(instance);
    registerSubjectRoutes(instance);
    registerEventRoutes(instance);
  };
  app.register(v1, { prefix: '/v1' });

  return app;
}
