import { createRequire } from "node:module";
import type { AuditRecord } from "@companyos/schemas";
import type { AuditSink } from "./index.js";

// Loaded via createRequire so the bundler never tries to resolve node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DB = InstanceType<typeof DatabaseSync>;

/**
 * Durable, append-only SQLite audit log (node-only — uses node:sqlite).
 * Implements the same `AuditSink` interface as InMemoryAudit, so it drops into
 * governance/brain unchanged. There is deliberately no update/delete API
 * (immutability, FR-8.4); a rolling digest makes tampering detectable.
 * Records survive process restarts (proven in sqlite.test.ts).
 */
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
  orgId: string;
  ts: string;
  actorType: string;
  actorId: string;
  action: string;
  resType: string;
  resId: string;
  traceId: string;
  costUsd: number | null;
  decision: string | null;
  metadata: string;
}

export class SqliteAudit implements AuditSink {
  private db: DB;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT, orgId TEXT, ts TEXT,
        actorType TEXT, actorId TEXT,
        action TEXT, resType TEXT, resId TEXT,
        traceId TEXT, costUsd REAL, decision TEXT, metadata TEXT
      )`
    );
  }

  append(record: AuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO audit (id, orgId, ts, actorType, actorId, action, resType, resId, traceId, costUsd, decision, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
        JSON.stringify(record.metadata ?? {})
      );
  }

  private rows(orgId: string): AuditRow[] {
    return this.db.prepare("SELECT * FROM audit WHERE orgId = ? ORDER BY seq").all(orgId) as unknown as AuditRow[];
  }

  list(orgId: string): AuditRecord[] {
    return this.rows(orgId).map((r) => {
      const rec: AuditRecord = {
        id: r.id,
        orgId: r.orgId,
        ts: r.ts,
        actor: { type: r.actorType as AuditRecord["actor"]["type"], id: r.actorId },
        action: r.action,
        resource: { type: r.resType, id: r.resId },
        traceId: r.traceId,
        metadata: JSON.parse(r.metadata) as Record<string, unknown>
      };
      if (r.costUsd != null) rec.costUsd = r.costUsd;
      if (r.decision != null) rec.decision = r.decision as AuditRecord["decision"];
      return rec;
    });
  }

  /** Tamper-evident digest over the org's chain (FR-8.4, T07.12). */
  digest(orgId: string): string {
    let h = "0";
    for (const r of this.rows(orgId)) h = fnv1a(h + JSON.stringify(r));
    return h;
  }

  close(): void {
    this.db.close();
  }
}
