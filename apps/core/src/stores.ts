/**
 * Persistence + authorization seams. The business logic in the packages is
 * backend-agnostic (AuthzEngine / AuditSink / MemoryStore interfaces); this
 * module picks the concrete adapter per CoreConfig so the same composition runs
 * in-memory (tests), on SQLite (local dev), or on Postgres+OpenFGA (platform).
 */
import { InMemoryAuthz, type AuthzEngine } from "@companyos/auth";
import { OpenFgaAuthz, createOpenFgaTransport } from "@companyos/auth/openfga";
import { SqliteAuthz } from "@companyos/auth/sqlite";
import { InMemoryAudit, type AuditSink } from "@companyos/telemetry";
import { SqliteAudit } from "@companyos/telemetry/sqlite";
import { InMemoryMemoryStore, type MemoryStore } from "@companyos/brain";
import { SqliteMemoryStore } from "@companyos/brain/sqlite";
import type { CoreConfig } from "./config.js";

export interface Stores {
  audit: AuditSink;
  memoryStore: MemoryStore;
  /** Optional teardown for sqlite/pg handles. */
  close?: () => Promise<void> | void;
}

export function createAuthz(config: CoreConfig): AuthzEngine {
  switch (config.authzBackend) {
    case "memory":
      return new InMemoryAuthz();
    case "sqlite":
      return new SqliteAuthz(config.sqlitePath);
    case "openfga": {
      if (!config.openfga?.storeId) {
        throw new Error(
          "OPENFGA_STORE_ID is required when AUTHZ_BACKEND=openfga. Run setupOpenFgaStore (see setup-the-company.sh / bootstrap) and set the id."
        );
      }
      const transport = createOpenFgaTransport({
        apiUrl: config.openfga.apiUrl,
        storeId: config.openfga.storeId,
        authorizationModelId: config.openfga.modelId
      });
      return new OpenFgaAuthz(transport);
    }
  }
}

export async function createStores(config: CoreConfig): Promise<Stores> {
  switch (config.persistence) {
    case "memory":
      return { audit: new InMemoryAudit(), memoryStore: new InMemoryMemoryStore() };
    case "sqlite": {
      const audit = new SqliteAudit(config.sqlitePath);
      const memoryStore = new SqliteMemoryStore(config.sqlitePath);
      return { audit, memoryStore };
    }
    case "postgres": {
      if (!config.databaseUrl) throw new Error("DATABASE_URL required for persistence=postgres");
      // Postgres + pgvector adapters (T1.1/T1.2/T3.3). Imported lazily so the
      // sqlite/memory paths stay dependency-free and runnable without a DB.
      const { createPostgresStores } = await import("./db/postgres-stores.js");
      return createPostgresStores(config.databaseUrl);
    }
  }
}
