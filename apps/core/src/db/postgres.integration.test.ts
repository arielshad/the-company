/**
 * Integration tests for the Postgres + pgvector persistence layer (T1.1/T1.2/T3.3).
 *
 * Skipped automatically unless DATABASE_URL is set (mirrors the OpenFGA
 * integration-test skip pattern). To run locally:
 *   docker compose up -d postgres   # a pgvector-enabled Postgres
 *   DATABASE_URL=postgres://...      pnpm vitest run apps/core/src/db
 *
 * Covered:
 *   - migrations apply cleanly (idempotent re-run is a no-op)
 *   - RLS blocks cross-org reads (tenant isolation, NFR-2)
 *   - the audit FNV-1a digest chain survives a "restart" (fresh PostgresAudit)
 *     and re-derives identically (tamper-evident, FR-8.4)
 *   - memory insert/get/getBySource/allByOrg round-trip durably
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AuditRecord } from "@companyos/schemas";
import type { BrainItem } from "@companyos/brain";
import { createPool, withOrg } from "./pool.js";
import { runMigrations } from "./migrate.js";
import { PostgresAudit } from "./audit.js";
import { PostgresMemoryStore } from "./memory-store.js";

const DB = process.env.DATABASE_URL;

// Unique per run so the append-only audit_log (no DELETE policy) does not
// accumulate rows across runs and break exact-count assertions.
const RUN = Date.now().toString(36);
const ORG_A = `org_test_a_${RUN}`;
const ORG_B = `org_test_b_${RUN}`;

function auditRecord(orgId: string, n: number): AuditRecord {
  return {
    id: `aud_${orgId}_${n}`,
    orgId,
    ts: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    actor: { type: "user", id: "user:alice" },
    action: "memory.write",
    resource: { type: "memory_object", id: `mem_${n}` },
    traceId: `trace_${n}`,
    decision: "allow",
    metadata: {}
  };
}

function brainItem(orgId: string, n: number): BrainItem {
  return {
    id: `mem_${orgId}_${n}`,
    orgId,
    kind: "doc",
    type: "document",
    title: `Doc ${n}`,
    content: `single sign-on configuration notes ${n}`,
    source: { connector: "notion", externalId: `ext_${n}` },
    confidence: 1,
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    visibility: []
  };
}

describe.skipIf(!DB)("Postgres persistence layer", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DB!);
    await runMigrations(pool);
    // Orgs are unique per run, so there is no prior state to clean. Seed the org
    // rows (each under its own RLS context so the WITH CHECK passes).
    for (const org of [ORG_A, ORG_B]) {
      await withOrg(pool, org, async (c) => {
        await c.query("INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
          org,
          org
        ]);
      });
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("applies migrations idempotently", async () => {
    const second = await runMigrations(pool);
    expect(second.applied).toHaveLength(0); // already applied → no-op
  });

  it("RLS blocks cross-org reads", async () => {
    const store = await PostgresMemoryStore.create(pool);
    store.insert(brainItem(ORG_A, 1));
    store.insert(brainItem(ORG_B, 1));
    await store.flush();

    // Org A's session sees only org A's row.
    const aRows = await withOrg(pool, ORG_A, async (c) => {
      const { rows } = await c.query("SELECT id, org_id FROM memory_items");
      return rows;
    });
    expect(aRows.every((r) => r.org_id === ORG_A)).toBe(true);
    expect(aRows.length).toBeGreaterThanOrEqual(1);

    // Org B cannot see org A's row, even by id.
    const leaked = await withOrg(pool, ORG_B, async (c) => {
      const { rows } = await c.query("SELECT id FROM memory_items WHERE org_id = $1", [ORG_A]);
      return rows;
    });
    expect(leaked).toHaveLength(0);
  });

  it("memory insert/get/getBySource/allByOrg round-trips durably", async () => {
    const store = await PostgresMemoryStore.create(pool);
    const item = brainItem(ORG_A, 42);
    store.insert(item);
    await store.flush();

    expect(store.get(item.id)?.title).toBe("Doc 42");
    expect(store.getBySource(ORG_A, "notion", "ext_42")?.id).toBe(item.id);

    // Fresh store (simulated restart) hydrates from Postgres. Under FORCE RLS the
    // unscoped org discovery returns nothing to a non-owner role, so name the org
    // to hydrate explicitly (the MVP single-tenant contract).
    process.env.MEMORY_HYDRATE_ORG = ORG_A;
    const reopened = await PostgresMemoryStore.create(pool);
    delete process.env.MEMORY_HYDRATE_ORG;
    const all = reopened.allByOrg(ORG_A);
    expect(all.find((i) => i.id === item.id)?.content).toContain("single sign-on");
  });

  it("audit digest chain survives a restart and re-derives identically", async () => {
    const audit = await PostgresAudit.create(pool);
    audit.append(auditRecord(ORG_A, 1));
    audit.append(auditRecord(ORG_A, 2));
    await audit.flush();

    const digestBefore = audit.digest(ORG_A);
    const records = audit.list(ORG_A);
    expect(records).toHaveLength(2);

    // Fresh instance (process restart): hydrate from audit_log.
    process.env.AUDIT_HYDRATE_ORG = ORG_A;
    const reopened = await PostgresAudit.create(pool);
    expect(reopened.list(ORG_A)).toHaveLength(2);
    expect(reopened.digest(ORG_A)).toBe(digestBefore); // chain intact across restart

    // Re-derive the chain from durable rows and confirm it matches the stored digest.
    const verify = await reopened.verifyChain(ORG_A);
    expect(verify.ok).toBe(true);
    expect(verify.stored).toBe(digestBefore);
    delete process.env.AUDIT_HYDRATE_ORG;
  });
});
