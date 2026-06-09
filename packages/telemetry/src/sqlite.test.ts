import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAudit } from "./sqlite.js";
import { makeAuditRecord } from "./index.js";

const rec = (orgId: string, action: string, extra: Partial<Parameters<typeof makeAuditRecord>[0]> = {}) =>
  makeAuditRecord({ orgId, actor: { type: "agent", id: "agent:bot" }, action, resource: { type: "brain", id: "b" }, ...extra });

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SqliteAudit", () => {
  it("appends and lists per org with metadata + cost round-tripping", () => {
    const audit = new SqliteAudit();
    audit.append(rec("acme", "tool.call", { costUsd: 0.0123, decision: "allow", metadata: { tool: "brain.search" } }));
    audit.append(rec("other", "tool.call"));
    const acme = audit.list("acme");
    expect(acme).toHaveLength(1);
    expect(acme[0]!.costUsd).toBeCloseTo(0.0123);
    expect(acme[0]!.decision).toBe("allow");
    expect(acme[0]!.metadata).toEqual({ tool: "brain.search" });
    audit.close();
  });

  it("digest changes on each append (tamper-evidence)", () => {
    const audit = new SqliteAudit();
    const d0 = audit.digest("acme");
    audit.append(rec("acme", "a"));
    const d1 = audit.digest("acme");
    audit.append(rec("acme", "b"));
    const d2 = audit.digest("acme");
    expect(new Set([d0, d1, d2]).size).toBe(3);
    audit.close();
  });

  it("persists the immutable log across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    tmpDirs.push(dir);
    const path = join(dir, "audit.db");

    const a = new SqliteAudit(path);
    a.append(rec("acme", "memory.write", { decision: "allow" }));
    a.append(rec("acme", "approval.decide", { decision: "allow" }));
    const digestBefore = a.digest("acme");
    a.close();

    const reopened = new SqliteAudit(path);
    expect(reopened.list("acme")).toHaveLength(2);
    expect(reopened.digest("acme")).toBe(digestBefore); // chain intact
    expect(reopened.list("acme").map((r) => r.action)).toEqual(["memory.write", "approval.decide"]);
    reopened.close();
  });

  it("exposes no mutation API (append-only)", () => {
    const audit = new SqliteAudit();
    expect((audit as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((audit as unknown as Record<string, unknown>).delete).toBeUndefined();
  });
});
