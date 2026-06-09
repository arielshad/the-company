import { describe, it, expect } from "vitest";
import { WorkflowEngine, type EngineDeps } from "./index.js";
import { BrainService } from "@companyos/brain";
import { GovernanceService } from "@companyos/governance";
import { InMemoryAudit, BudgetTracker } from "@companyos/telemetry";
import { seedAcme, alice, ORG } from "@companyos/testing";
import type { Workflow } from "@companyos/dsl";

function setup(extra: Partial<EngineDeps> = {}) {
  const authz = seedAcme();
  const audit = new InMemoryAudit();
  const brain = new BrainService(authz, audit);
  const governance = new GovernanceService(authz, audit, new BudgetTracker());
  const engine = new WorkflowEngine({ brain, governance, ...extra });
  return { engine, brain, governance, audit };
}

const meta = { orgId: ORG, version: 1, state: "published" as const };

describe("WorkflowEngine — linear run", () => {
  it("runs trigger -> brain_search -> end", async () => {
    const { engine, brain } = setup();
    brain.ingest({ orgId: ORG, source: { connector: "notion", externalId: "d1" }, title: "Roadmap", content: "SSO is planned for August" });
    const wf: Workflow = {
      id: "wf-search",
      name: "search",
      ...meta,
      trigger: { id: "t", type: "trigger", trigger: "manual" },
      nodes: [
        { id: "s", type: "brain_search", query: "{{input.q}}" },
        { id: "e", type: "end" }
      ],
      edges: [{ from: "t", to: "s" }, { from: "s", to: "e" }],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: [], minConfidence: 0 },
      evalPolicy: { evals: [], gate: "advisory", thresholds: {} }
    };
    const run = await engine.start(engine.publish(wf), alice, { q: "SSO August" });
    expect(run.status).toBe("completed");
    expect(run.context.s.hits.length).toBeGreaterThan(0);
  });
});

describe("WorkflowEngine — condition branching", () => {
  it("follows the true branch", async () => {
    const ran: string[] = [];
    const { engine } = setup({
      tools: {
        markA: () => { ran.push("A"); return { branch: "A" }; },
        markB: () => { ran.push("B"); return { branch: "B" }; }
      }
    });
    const wf: Workflow = {
      id: "wf-cond",
      name: "cond",
      ...meta,
      trigger: { id: "t", type: "trigger", trigger: "manual" },
      nodes: [
        { id: "c", type: "condition", predicate: { any: [{ field: "input.flag", op: "==", value: true }] } },
        { id: "a", type: "tool", tool: "markA" },
        { id: "b", type: "tool", tool: "markB" },
        { id: "e", type: "end" }
      ],
      edges: [
        { from: "t", to: "c" },
        { from: "c", to: "a", when: "true" },
        { from: "c", to: "b", when: "false" },
        { from: "a", to: "e" },
        { from: "b", to: "e" }
      ],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: [], minConfidence: 0 },
      evalPolicy: { evals: [], gate: "advisory", thresholds: {} }
    };
    const run = await engine.start(engine.publish(wf), alice, { flag: true });
    expect(run.status).toBe("completed");
    expect(ran).toEqual(["A"]);
  });
});

describe("WorkflowEngine — approval pause/resume (FR-6.6)", () => {
  it("pauses at approval and resumes to write memory after approval", async () => {
    const { engine, governance, brain } = setup({
      agents: {
        extract: async () => ({
          output: { decisions: ["prioritize SSO for August"], confidence: 0.95, customer: "Globex", title: "Globex renewal" },
          model: "claude-sonnet-4-6",
          inputTokens: 500,
          outputTokens: 100
        })
      }
    });
    const wf: Workflow = {
      id: "wf-approve",
      name: "approve",
      ...meta,
      trigger: { id: "t", type: "trigger", trigger: "zoom_transcript" },
      nodes: [
        { id: "extract", type: "agent", handler: "extract", agent: { role: "Researcher", budgetUsd: 1 } },
        { id: "appr", type: "approval", policy: { triggers: [], approvers: ["user:alice"], onTimeout: "escalate" } },
        { id: "write", type: "memory_write", memoryType: "decision" },
        { id: "e", type: "end" }
      ],
      edges: [
        { from: "t", to: "extract" },
        { from: "extract", to: "appr" },
        { from: "appr", to: "write" },
        { from: "write", to: "e" }
      ],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: ["decision"], minConfidence: 0.5 },
      evalPolicy: { evals: [], gate: "advisory", thresholds: {} }
    };
    const run = await engine.start(engine.publish(wf), alice, { meetingId: "z1" });
    expect(run.status).toBe("paused");
    expect(run.awaiting?.approvalId).toBeDefined();

    governance.decide(run.awaiting!.approvalId, alice, "approved");
    const resumed = await engine.resume(run.id);
    expect(resumed.status).toBe("completed");
    expect(brain.count(ORG)).toBe(1);
  });

  it("fails the run if approval is rejected", async () => {
    const { engine, governance } = setup({
      agents: { extract: async () => ({ output: { decisions: ["x"], confidence: 0.9 }, model: "m", inputTokens: 1, outputTokens: 1 }) }
    });
    const wf: Workflow = {
      id: "wf-reject",
      name: "reject",
      ...meta,
      trigger: { id: "t", type: "trigger", trigger: "manual" },
      nodes: [
        { id: "extract", type: "agent", handler: "extract", agent: { role: "R", budgetUsd: 1 } },
        { id: "appr", type: "approval", policy: { triggers: [], approvers: [], onTimeout: "escalate" } },
        { id: "write", type: "memory_write", memoryType: "decision" },
        { id: "e", type: "end" }
      ],
      edges: [{ from: "t", to: "extract" }, { from: "extract", to: "appr" }, { from: "appr", to: "write" }, { from: "write", to: "e" }],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: ["decision"], minConfidence: 0.5 },
      evalPolicy: { evals: [], gate: "advisory", thresholds: {} }
    };
    const run = await engine.start(engine.publish(wf), alice, {});
    governance.decide(run.awaiting!.approvalId, alice, "rejected");
    const resumed = await engine.resume(run.id);
    expect(resumed.status).toBe("failed");
    expect(resumed.error).toBe("approval_rejected");
  });
});

describe("WorkflowEngine — eval gate blocks external effects (FR-8.3)", () => {
  it("stops before notify when eval is blocked", async () => {
    const notified: string[] = [];
    const { engine } = setup({
      notifiers: { slack: () => { notified.push("sent"); return { sent: true }; } },
      // extract produces a claim with no supporting transcript → uncited
      agents: { extract: async () => ({ output: { decisions: ["unsupported claim about revenue"] }, model: "m", inputTokens: 1, outputTokens: 1 }) }
    });
    const wf: Workflow = {
      id: "wf-eval",
      name: "eval",
      ...meta,
      trigger: { id: "t", type: "trigger", trigger: "manual" },
      nodes: [
        { id: "extract", type: "agent", handler: "extract", agent: { role: "R", budgetUsd: 1 } },
        { id: "ev", type: "eval", policy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.7 } } },
        { id: "n", type: "notify", channel: "slack" },
        { id: "e", type: "end" }
      ],
      edges: [{ from: "t", to: "extract" }, { from: "extract", to: "ev" }, { from: "ev", to: "n" }, { from: "n", to: "e" }],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: [], minConfidence: 0 },
      evalPolicy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.7 } }
    };
    const run = await engine.start(engine.publish(wf), alice, { transcript: "" });
    expect(run.status).toBe("failed");
    expect(notified).toHaveLength(0);
  });
});

describe("WorkflowEngine — bounded loop", () => {
  it("terminates a loop at maxIterations", async () => {
    let work = 0;
    const { engine } = setup({ tools: { doWork: () => { work++; return { work }; } } });
    const wf: Workflow = {
      id: "wf-loop",
      name: "loop",
      ...meta,
      trigger: { id: "t", type: "trigger", trigger: "manual" },
      nodes: [
        { id: "loop", type: "loop", maxIterations: 3 },
        { id: "w", type: "tool", tool: "doWork" },
        { id: "e", type: "end" }
      ],
      edges: [
        { from: "t", to: "loop" },
        { from: "loop", to: "w", when: "retry" },
        { from: "w", to: "loop" },
        { from: "loop", to: "e", when: "exit" }
      ],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: [], minConfidence: 0 },
      evalPolicy: { evals: [], gate: "advisory", thresholds: {} }
    };
    const run = await engine.start(engine.publish(wf), alice, {});
    expect(run.status).toBe("completed");
    expect(work).toBe(2); // iterations 1,2 take retry; iteration 3 exits
  });
});
