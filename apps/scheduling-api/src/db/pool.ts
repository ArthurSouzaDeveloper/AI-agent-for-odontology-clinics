import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Uma transação que fica pendurada segurando uma trava de agenda é pior
    // que uma que falha rápido.
    statement_timeout: 10_000,
  });
  return pool;
}

/** Transação com rollback automático em erro. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // conexão já perdida; o pool descarta
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Códigos do Postgres que o domínio interpreta. */
export const PG = {
  EXCLUSION_VIOLATION: '23P01',
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

export function isConstraintViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'constraint' in err &&
    (err as { constraint?: unknown }).constraint === constraint
  );
}
