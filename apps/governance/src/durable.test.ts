import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GovernanceService } from "./index.js";
import { SqliteAuthz } from "@companyos/auth/sqlite";
import { SqliteAudit } from "@companyos/telemetry/sqlite";
import { BudgetTracker } from "@companyos/telemetry";
import { alice, bob, ORG } from "@companyos/testing";

/**
 * Proves the durable SQLite backends drop into a real service unchanged: the
 * SAME GovernanceService runs on SqliteAuthz + SqliteAudit, and the audit trail
 * survives a "process restart" (reopen of the same DB file).
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedSqliteAuthz(path?: string): SqliteAuthz {
  const fga = new SqliteAuthz(path);
  fga.write({ subject: alice.id, relation: "admin", object: `org:${ORG}` });
  fga.write({ subject: bob.id, relation: "member", object: `org:${ORG}` });
  fga.write({ subject: `org:${ORG}`, relation: "parent", object: `brain:${ORG}` });
  return fga;
}

describe("GovernanceService on durable SQLite backends", () => {
  it("authorizes against SqliteAuthz and persists the audit across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-"));
    dirs.push(dir);
    const auditPath = join(dir, "audit.db");

    const authz = seedSqliteAuthz();
    const audit = new SqliteAudit(auditPath);
    const gov = new GovernanceService(authz, audit, new BudgetTracker());

    expect(gov.authorize(alice, "writer", `brain:${ORG}`, "memory.write")).toBe(true); // admin → writer
    expect(gov.authorize(bob, "writer", `brain:${ORG}`, "memory.write")).toBe(false); // member → denied

    const digestBefore = audit.digest(ORG);
    audit.close();
    authz.close();

    // reopen the audit DB as a fresh process would — both decisions are still there
    const reopened = new SqliteAudit(auditPath);
    const records = reopened.list(ORG);
    expect(records).toHaveLength(2);
    expect(records.filter((r) => r.decision === "allow")).toHaveLength(1);
    expect(records.filter((r) => r.decision === "deny")).toHaveLength(1);
    expect(reopened.digest(ORG)).toBe(digestBefore); // tamper-evident chain intact
    reopened.close();
  });
});
