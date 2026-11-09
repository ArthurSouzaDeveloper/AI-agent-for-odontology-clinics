import type { FastifyInstance } from 'fastify';
import { requireScope } from '../auth.ts';

/**
 * SSE para o painel. Em vez de LISTEN/NOTIFY nesta primeira fatia, o stream
 * lê a tabela `outbox_events` com um cursor: simples, sobrevive a reconexão
 * (Last-Event-ID) e nunca perde evento. Latência típica < 1 s.
 *
 * O payload leva ids e metadados, não dado clínico; o painel busca o detalhe
 * por REST com o token do usuário, então RBAC e auditoria valem no tempo real.
 */
const POLL_INTERVAL_MS = 750;
const HEARTBEAT_MS = 15_000;

export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/events/stream', async (req, reply) => {
    requireScope(req.principal, 'appointments:read');
    const tenantId = req.principal.tenantId;
    const db = req.ctx.db;

    const lastEventId = req.headers['last-event-id'];
    let cursor = 0;
    if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
      cursor = Number(lastEventId);
    } else {
      // Conexão nova: começa do fim, sem reproduzir histórico.
      const { rows } = await db.query<{ max: string | null }>(
        'SELECT max(id)::text AS max FROM outbox_events WHERE tenant_id = $1',
        [tenantId],
      );
      cursor = Number(rows[0]?.max ?? 0);
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': String(req.id),
    });
    res.write('retry: 3000\n\n');

    let closed = false;
    let busy = false;

    const flush = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const { rows } = await db.query<{
          id: string;
          type: string;
          payload: unknown;
          occurred_at: Date;
        }>(
          `SELECT id::text, type, payload, occurred_at
             FROM outbox_events
            WHERE tenant_id = $1 AND id > $2
            ORDER BY id
            LIMIT 100`,
          [tenantId, cursor],
        );
        for (const row of rows) {
          cursor = Number(row.id);
          res.write(
            `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify({
              ...(row.payload as object),
              occurred_at: row.occurred_at.toISOString(),
            })}\n\n`,
          );
        }
      } catch (err) {
        req.log.error({ err }, 'falha ao ler outbox para SSE');
      } finally {
        busy = false;
      }
    };

    const poll = setInterval(() => void flush(), POLL_INTERVAL_MS);
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    req.raw.on('close', () => {
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
    });

    await flush();
  });
}
