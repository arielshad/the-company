import { describe, it, expect } from "vitest";
import { GovernanceService } from "./index.js";
import { InMemoryAudit, BudgetTracker } from "@companyos/telemetry";
import { seedAcme, alice, bob, ORG } from "@companyos/testing";

function make() {
  const audit = new InMemoryAudit();
  const gov = new GovernanceService(seedAcme(), audit, new BudgetTracker());
  return { gov, audit };
}

describe("authorize", () => {
  it("allows a writer and audits allow", () => {
    const { gov, audit } = make();
    expect(gov.authorize(alice, "writer", `brain:${ORG}`, "memory.write")).toBe(true);
    expect(audit.list(ORG).some((a) => a.decision === "allow")).toBe(true);
  });
  it("denies and audits deny", () => {
    const { gov, audit } = make();
    expect(gov.authorize(bob, "writer", `brain:${ORG}`, "memory.write")).toBe(false);
    expect(audit.list(ORG).some((a) => a.decision === "deny")).toBe(true);
  });
});

describe("approvals", () => {
  it("creates, lists, and resolves an approval (approve)", () => {
    const { gov } = make();
    const req = gov.createApproval({
      orgId: ORG,
      runId: "r1",
      nodeId: "approve",
      policy: { triggers: [], approvers: ["user:alice"], onTimeout: "escalate" },
      payload: { confidence: 0.6 }
    });
    expect(gov.listPending(ORG)).toHaveLength(1);
    const decided = gov.decide(req.id, alice, "approved", "looks good");
    expect(decided.status).toBe("approved");
    expect(gov.listPending(ORG)).toHaveLength(0);
  });

  it("escalates on timeout", () => {
    const { gov } = make();
    const req = gov.createApproval({
      orgId: ORG,
      runId: "r1",
      nodeId: "approve",
      policy: { triggers: [], approvers: [], escalateAfterMinutes: 60, onTimeout: "escalate" },
      payload: {}
    });
    const later = req.createdAt + 61 * 60_000;
    expect(gov.resolveTimeout(req.id, later)?.status).toBe("escalated");
  });

  it("auto-approves on timeout when policy says so", () => {
    const { gov } = make();
    const req = gov.createApproval({
      orgId: ORG,
      runId: "r1",
      nodeId: "approve",
      policy: { triggers: [], approvers: [], escalateAfterMinutes: 1, onTimeout: "auto_approve" },
      payload: {}
    });
    expect(gov.resolveTimeout(req.id, req.createdAt + 2 * 60_000)?.status).toBe("approved");
  });
});

describe("budget enforcement", () => {
  it("emits budget.exceeded when cap is passed", () => {
    const { gov, audit } = make();
    gov.chargeModelUsage("a1", ORG, 0.01, "claude-sonnet-4-6", 1_000_000, 1_000_000); // ~$18
    expect(audit.list(ORG).some((a) => a.action === "budget.exceeded")).toBe(true);
  });
});

describe("eval gate", () => {
  it("blocks on failing eval under gate=block", () => {
    const { gov } = make();
    const r = gov.runEvalGate(
      ORG,
      { claims: ["uncited claim"], citations: [] },
      { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.7 } }
    );
    expect(r.blocked).toBe(true);
  });
});
