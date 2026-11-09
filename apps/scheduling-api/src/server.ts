import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { migrate } from './db/migrate.ts';
import { expireStaleHolds } from './domain/booking.ts';
import { createPool } from './db/pool.ts';

const config = loadConfig();

if (config.NODE_ENV !== 'production') {
  await migrate(config.DATABASE_URL);
}

const db = createPool(config.DATABASE_URL);
const app = buildApp(config, db);

// Limpa reservas vencidas a cada minuto. A trava do banco já impede
// overbooking; isto só evita que um horário pareça ocupado por mais tempo.
const sweeper = setInterval(() => {
  expireStaleHolds(db).catch((err: unknown) => app.log.error({ err }, 'falha ao expirar holds'));
}, 60_000);

const shutdown = async () => {
  clearInterval(sweeper);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
