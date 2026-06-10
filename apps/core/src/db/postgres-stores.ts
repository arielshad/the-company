/**
 * Postgres + pgvector adapters (T1.1 schema/RLS, T1.2 durable Authz/Audit,
 * T3.3 pgvector MemoryStore) — STUB. Returns the {audit, memoryStore} the core
 * composition needs, backed by the shared CNPG `the_company` DB.
 *
 * Replace with real `pg`-backed implementations of AuditSink + MemoryStore that
 * preserve the audit digest chain and run RLS-isolated, org-scoped queries.
 */
import type { Stores } from "../stores.js";

export function createPostgresStores(_databaseUrl: string): Stores {
  throw new Error(
    "Postgres stores not implemented yet (T1.1/T1.2/T3.3). Use PERSISTENCE=sqlite|memory until the pg adapters land."
  );
}
