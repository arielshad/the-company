/**
 * PostgresAudit — append-only AuditSink backed by `audit_log` (T1.2).
 *
 * The AuditSink interface is synchronous (append/list/digest) because its
 * reference impls (InMemoryAudit, SqliteAudit) are synchronous, and the core
 * (apps/core/src/platform.ts) calls `audit.list()` / `audit.digest()` inline in
 * request handlers. Postgres I/O is async, so this adapter keeps a write-through
 * in-memory mirror of the durable log:
 *   - construct via `PostgresAudit.create(pool)` which HYDRATES the mirror from
 *     `audit_log` (so the chain survives a process restart), then
 *   - `append()` updates the mirror synchronously AND enqueues an ordered async
 *     INSERT (fire-and-forget; failures surface via onError / flush()).
 *   - `list()` / `digest()` read the mirror synchronously.
 *
 * Tamper-evident rolling FNV-1a digest, preserved EXACTLY from
 * @companyos/telemetry InMemoryAudit:
 *     prev = chain[org] ?? "0";  chain[org] = fnv1a(prev + JSON.stringify(record))
 * where `record` is the zod-parsed AuditRecord (schema key order; absent
 * optionals omitted). We persist each row's chain value in `row_digest` so the
 * durable store is itself verifiable, and re-deriving from the persisted records
 * reproduces the same chain (verifyChain). The adapter never issues UPDATE/DELETE
 * (immutability, FR-8.4); RLS in the schema also forbids it.
 */
import type { AuditRecord } from "@companyos/schemas";
import type { AuditSink } from "@companyos/telemetry";
import type { Pool } from "pg";
import { withOrg } from "./pool.js";

/** FNV-1a — copied verbatim from telemetry so chains match bit-for-bit. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface AuditRow {
  id: string;
  org_id: string;
  ts: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  trace_id: string;
  cost_usd: number | null;
  decision: string | null;
  metadata: Record<string, unknown>;
}

function rowToRecord(r: AuditRow): AuditRecord {
  const rec: AuditRecord = {
    id: r.id,
    orgId: r.org_id,
    ts: r.ts,
    actor: { type: r.actor_type as AuditRecord["actor"]["type"], id: r.actor_id },
    action: r.action,
    resource: { type: r.resource_type, id: r.resource_id },
    traceId: r.trace_id,
    metadata: r.metadata ?? {}
  };
  if (r.cost_usd != null) rec.costUsd = r.cost_usd;
  if (r.decision != null) rec.decision = r.decision as AuditRecord["decision"];
  return rec;
}

/**
 * Canonical JSON InMemoryAudit hashes: object rebuilt in zod-schema key order
 * with undefined optionals omitted, so JSON.stringify is byte-identical to
 * `JSON.stringify({ ...parsedRecord })`.
 */
function canonicalJson(rec: AuditRecord): string {
  const ordered: Record<string, unknown> = {
    id: rec.id,
    orgId: rec.orgId,
    ts: rec.ts,
    actor: rec.actor,
    action: rec.action,
    resource: rec.resource,
    traceId: rec.traceId
  };
  if (rec.costUsd !== undefined) ordered.costUsd = rec.costUsd;
  if (rec.decision !== undefined) ordered.decision = rec.decision;
  ordered.metadata = rec.metadata ?? {};
  return JSON.stringify(ordered);
}

export class PostgresAudit implements AuditSink {
  private records: AuditRecord[] = [];
  private chain = new Map<string, string>(); // orgId -> rolling digest
  /** Serialized async write tail so durable inserts keep append order. */
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    private pool: Pool,
    private onError: (err: unknown) => void = (e) => console.error("[PostgresAudit] write failed:", e)
  ) {}

  /**
   * Build an adapter and hydrate the in-memory mirror from the durable log so
   * list()/digest() are correct immediately and the chain continues across a
   * restart. Hydrates every org present in `audit_log`.
   */
  static async create(pool: Pool, onError?: (err: unknown) => void): Promise<PostgresAudit> {
    const audit = new PostgresAudit(pool, onError);
    await audit.hydrate();
    return audit;
  }

  private async hydrate(): Promise<void> {
    // Distinct orgs, then load each org's chain under its own RLS context.
    // (A direct cross-org scan is blocked by RLS by design.)
    const orgs = await this.allOrgIds();
    for (const orgId of orgs) {
      const records = await withOrg(this.pool, orgId, async (client) => {
        const { rows } = await client.query<AuditRow>(
          `SELECT id, org_id, ts, actor_type, actor_id, action, resource_type, resource_id,
                  trace_id, cost_usd, decision, metadata
           FROM audit_log ORDER BY seq`
        );
        return rows.map(rowToRecord);
      });
      for (const rec of records) {
        this.records.push(Object.freeze({ ...rec }));
        const prev = this.chain.get(orgId) ?? "0";
        this.chain.set(orgId, fnv1a(prev + canonicalJson(rec)));
      }
    }
  }

  /**
   * Org ids to hydrate on startup. `audit_log` has FORCE RLS, so an unscoped
   * `SELECT DISTINCT org_id` returns rows only for a connecting role with
   * BYPASSRLS (e.g. the platform's migration/owner role); otherwise it returns
   * nothing. Set AUDIT_HYDRATE_ORG to hydrate a specific org explicitly (the
   * MVP single-tenant case, W2.3).
   *
   * Hydration is an OPTIMIZATION, not a correctness requirement: every append
   * re-derives its `prev` from the persisted `row_digest` tail inside its own
   * transaction, so the durable chain is always continued correctly even for an
   * org that was never hydrated. Hydration only backfills list()/digest() with
   * pre-restart history.
   */
  private async allOrgIds(): Promise<string[]> {
    const explicit = process.env.AUDIT_HYDRATE_ORG;
    if (explicit) return explicit.split(",").map((s) => s.trim()).filter(Boolean);
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ org_id: string }>(
        "SELECT DISTINCT org_id FROM audit_log"
      );
      return rows.map((r) => r.org_id);
    } catch {
      return [];
    } finally {
      client.release();
    }
  }

  append(record: AuditRecord): void {
    // Synchronous mirror update (interface contract): chain advances now.
    const frozen = Object.freeze({ ...record });
    this.records.push(frozen);
    const prev = this.chain.get(record.orgId) ?? "0";
    const rowDigest = fnv1a(prev + canonicalJson(record));
    this.chain.set(record.orgId, rowDigest);

    // Ordered async durable write. If the org was not hydrated, derive `prev`
    // from the persisted tail inside the transaction so the row_digest is right.
    this.writeTail = this.writeTail.then(() =>
      withOrg(this.pool, record.orgId, async (client) => {
        const { rows } = await client.query<{ row_digest: string }>(
          "SELECT row_digest FROM audit_log ORDER BY seq DESC LIMIT 1"
        );
        const persistedPrev = rows[0]?.row_digest ?? "0";
        const digestToStore = fnv1a(persistedPrev + canonicalJson(record));
        await client.query(
          `INSERT INTO audit_log
             (id, org_id, ts, actor_type, actor_id, action, resource_type, resource_id,
              trace_id, cost_usd, decision, metadata, row_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            record.id,
            record.orgId,
            record.ts,
            record.actor.type,
            record.actor.id,
            record.action,
            record.resource.type,
            record.resource.id,
            record.traceId,
            record.costUsd ?? null,
            record.decision ?? null,
            JSON.stringify(record.metadata ?? {}),
            digestToStore
          ]
        );
      }).catch(this.onError)
    );
  }

  /** Await all queued durable writes (tests/shutdown). */
  async flush(): Promise<void> {
    await this.writeTail;
  }

  list(orgId: string): AuditRecord[] {
    return this.records.filter((r) => r.orgId === orgId).map((r) => ({ ...r }));
  }

  digest(orgId: string): string {
    return this.chain.get(orgId) ?? "0";
  }

  /**
   * Re-derive the chain from the DURABLE records and confirm it equals the
   * persisted latest row_digest — proves the log was not tampered with and that
   * the in-memory mirror matches Postgres (FR-8.4).
   */
  async verifyChain(orgId: string): Promise<{ ok: boolean; derived: string; stored: string }> {
    await this.flush();
    return withOrg(this.pool, orgId, async (client) => {
      const { rows } = await client.query<AuditRow & { row_digest: string }>(
        `SELECT id, org_id, ts, actor_type, actor_id, action, resource_type, resource_id,
                trace_id, cost_usd, decision, metadata, row_digest
         FROM audit_log ORDER BY seq`
      );
      let h = "0";
      for (const r of rows) h = fnv1a(h + canonicalJson(rowToRecord(r)));
      const stored = rows.length ? rows[rows.length - 1]!.row_digest : "0";
      return { ok: h === stored, derived: h, stored };
    });
  }
}
