/**
 * pg Pool factory + the RLS `withOrg` helper.
 *
 * All tenant-scoped queries must run inside `withOrg(pool, orgId, fn)`, which
 * opens a transaction, sets `app.org_id` for that transaction only
 * (`SET LOCAL`), and runs `fn` against the bound client. The RLS policies in
 * migrations/0001_init.sql key on `current_setting('app.org_id')`, so a query
 * made outside `withOrg` (GUC unset → NULL) sees zero tenant rows (fail-closed).
 */
import { Pool, type PoolClient, type PoolConfig } from "pg";

/** Create a shared pool from a DATABASE_URL connection string. */
export function createPool(databaseUrl: string, overrides: PoolConfig = {}): Pool {
  return new Pool({ connectionString: databaseUrl, ...overrides });
}

/**
 * Run `fn` inside a transaction with `app.org_id` bound to `orgId` so RLS
 * applies. The GUC is set with `SET LOCAL`, scoping it to this transaction; it
 * is automatically discarded on COMMIT/ROLLBACK and never leaks to a pooled
 * connection's next user.
 *
 * `set_config(name, value, is_local=true)` is used (parameterized) rather than
 * an interpolated `SET LOCAL` so the org id can never be a SQL-injection vector.
 */
export async function withOrg<T>(
  pool: Pool,
  orgId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // is_local = true → SET LOCAL semantics (transaction-scoped).
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure; surface the original error */
    }
    throw err;
  } finally {
    client.release();
  }
}
