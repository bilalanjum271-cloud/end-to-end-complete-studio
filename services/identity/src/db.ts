import { Pool, PoolClient } from 'pg';

export const POOL = Symbol('POOL');

/** Runs fn in a transaction, retrying serialization failures that distributed SQL returns under contention. */
export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < 5) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
