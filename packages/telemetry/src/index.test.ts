import { describe, it, expect } from "vitest";
import {
  createLogger,
  InMemoryAudit,
  makeAuditRecord,
  meterCostUsd,
  BudgetTracker
} from "./index.js";

describe("logger", () => {
  it("emits structured JSON with bindings", () => {
    const lines: string[] = [];
    const log = createLogger({ svc: "brain" }, (l) => lines.push(l));
    log.child({ traceId: "t1" }).info("hello", { n: 1 });
    const obj = JSON.parse(lines[0]!);
    expect(obj).toMatchObject({ svc: "brain", traceId: "t1", msg: "hello", n: 1, level: "info" });
  });
});

describe("audit", () => {
  it("appends and lists per org, immutably", () => {
    const audit = new InMemoryAudit();
    audit.append(makeAuditRecord({ orgId: "acme", actor: { type: "user", id: "u" }, action: "x", resource: { type: "brain", id: "b" } }));
    audit.append(makeAuditRecord({ orgId: "other", actor: { type: "user", id: "u" }, action: "y", resource: { type: "brain", id: "b" } }));
    const acme = audit.list("acme");
    expect(acme).toHaveLength(1);
    // mutating the returned copy does not affect the store
    acme[0]!.action = "tampered";
    expect(audit.list("acme")[0]!.action).toBe("x");
  });

  it("digest changes when records are added (tamper-evidence)", () => {
    const audit = new InMemoryAudit();
    const d0 = audit.digest("acme");
    audit.append(makeAuditRecord({ orgId: "acme", actor: { type: "agent", id: "a" }, action: "tool.call", resource: { type: "tool", id: "t" } }));
    const d1 = audit.digest("acme");
    audit.append(makeAuditRecord({ orgId: "acme", actor: { type: "agent", id: "a" }, action: "tool.call", resource: { type: "tool", id: "t" } }));
    const d2 = audit.digest("acme");
    expect(new Set([d0, d1, d2]).size).toBe(3);
  });
});

describe("cost metering", () => {
  it("meters cost by model price", () => {
    expect(meterCostUsd("claude-sonnet-4-6", 1_000_000, 0)).toBeCloseTo(3);
    expect(meterCostUsd("claude-sonnet-4-6", 0, 1_000_000)).toBeCloseTo(15);
    expect(meterCostUsd("unknown-model", 1_000_000, 0)).toBeCloseTo(3); // default
  });
});

describe("BudgetTracker", () => {
  it("warns at 80% and stops at 100%", () => {
    const b = new BudgetTracker();
    expect(b.record("a1", 100, 50).status).toBe("ok");
    expect(b.record("a1", 100, 35).status).toBe("warn"); // 85
    expect(b.record("a1", 100, 20).status).toBe("exceeded"); // 105
    expect(b.spent("a1")).toBe(105);
  });

  it("preCheck projects without recording", () => {
    const b = new BudgetTracker();
    b.record("a1", 100, 90);
    expect(b.preCheck("a1", 100, 5).status).toBe("warn");
    expect(b.preCheck("a1", 100, 20).status).toBe("exceeded");
    expect(b.spent("a1")).toBe(90); // unchanged
  });

  it("uncapped (0) budget is always ok", () => {
    const b = new BudgetTracker();
    expect(b.record("a1", 0, 1000).status).toBe("ok");
  });
});
