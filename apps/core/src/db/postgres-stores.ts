/**
 * Postgres + pgvector adapters (T1.1 schema/RLS, T1.2 durable Audit, T3.3
 * pgvector MemoryStore). Wires a single shared `pg` Pool into PostgresAudit +
 * PostgresMemoryStore, backed by the shared CNPG `the_company` DB (ADR-0008).
 *
 * Returns the `Stores` the core composition needs. Both adapters keep a
 * write-through in-memory mirror hydrated from the durable tables at startup, so
 * the synchronous AuditSink / MemoryStore interfaces are honored while writes
 * land durably (and survive restart). `close()` flushes pending writes then ends
 * the pool.
 */
import type { Stores } from "../stores.js";
import { createPool } from "./pool.js";
import { PostgresAudit } from "./audit.js";
import { PostgresMemoryStore } from "./memory-store.js";

export async function createPostgresStores(databaseUrl: string): Promise<Stores> {
  const pool = createPool(databaseUrl);
  const [audit, memoryStore] = await Promise.all([
    PostgresAudit.create(pool),
    PostgresMemoryStore.create(pool)
  ]);
  return {
    audit,
    memoryStore,
    close: async () => {
      // Drain ordered async writes before tearing down the pool.
      await Promise.allSettled([audit.flush(), memoryStore.flush()]);
      await pool.end();
    }
  };
}
