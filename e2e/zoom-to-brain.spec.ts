import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { InMemoryAuthz } from "@companyos/auth";
import { BrainService } from "@companyos/brain";
import { GovernanceService } from "@companyos/governance";
import { WorkflowEngine } from "@companyos/workflow-engine";
import { SkillRegistry } from "@companyos/skill-registry";
import { McpGateway } from "@companyos/gateway";
import { ZoomConnector, cleanTranscript } from "@companyos/connectors";
import { InMemoryAudit, BudgetTracker } from "@companyos/telemetry";
import { seedAcme, alice, opsAgent, sampleZoomTranscript, ORG } from "@companyos/testing";
import type { Workflow } from "@companyos/dsl";

const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "artifacts");

/**
 * FLAGSHIP e2e (docs/01 §6, docs/05 §4): proves the whole platform works
 * end-to-end — connectors → workflow engine → agents → eval gate → approval →
 * brain write → tasking → notify → retrieval via MCP, all under governance.
 */
describe("FLAGSHIP: Zoom transcript → company brain", () => {
  it("ingests a meeting, gates + approves, writes memory, tasks + notifies, and exposes it via MCP", async () => {
    // ---- platform wiring ----
    const authz: InMemoryAuthz = seedAcme();
    const audit = new InMemoryAudit();
    const brain = new BrainService(authz, audit);
    const governance = new GovernanceService(authz, audit, new BudgetTracker());

    // the ops agent runs the workflow → grant it brain writer + workflow trigger
    authz.write({ subject: opsAgent.id, relation: "writer", object: `brain:${ORG}` });
    authz.write({ subject: opsAgent.id, relation: "trigger", object: "workflow:wf_zoom_to_brain" });

    // side-effect sinks (mock Jira + Slack)
    const tickets: unknown[] = [];
    const slack: unknown[] = [];

    const engine = new WorkflowEngine({
      brain,
      governance,
      tools: {
        "text.clean_transcript": (_node, ctx) => ({ text: cleanTranscript(String(ctx.input?.transcript ?? "")) })
      },
      agents: {
        // deterministic "extraction agent" standing in for an LLM agent node
        extract_meeting: async (ctx) => {
          const t = String(ctx.clean?.text ?? ctx.input?.transcript ?? "");
          return {
            output: {
              title: "Globex — Q3 renewal",
              customer: "Globex",
              customerSensitive: true,
              confidence: 0.9,
              decisions: ["prioritize SSO for the August release"],
              risks: ["SSO slipping past August may delay Globex expansion"],
              customerFacts: ["Globex expansion budget approved at 250 seats"],
              actionItems: ["Bob to scope SSO work and open a Jira ticket"],
              transcriptLen: t.length
            },
            model: "claude-sonnet-4-6",
            inputTokens: 1200,
            outputTokens: 180
          };
        }
      },
      tasks: {
        create_tickets: (_n, ctx) => {
          const ticket = { id: "GLOBEX-1", summary: (ctx.extract?.actionItems ?? [])[0] ?? "follow up", target: "jira" };
          tickets.push(ticket);
          return ticket;
        }
      },
      notifiers: {
        slack: (_n, ctx) => {
          const msg = { channel: "#team-updates", text: `New decision recorded: ${ctx.extract?.decisions?.[0]}` };
          slack.push(msg);
          return msg;
        }
      }
    });

    const skills = new SkillRegistry();
    const gateway = new McpGateway({
      authz,
      governance,
      brain,
      engine,
      skills,
      getWorkflow: (id) => (id === wf.id ? wf : undefined)
    });

    // ---- the flagship workflow (DSL) ----
    const wf: Workflow = {
      id: "wf_zoom_to_brain",
      orgId: ORG,
      name: "Zoom transcript to company brain",
      version: 3,
      state: "published",
      trigger: { id: "t1", type: "trigger", trigger: "zoom_transcript" },
      nodes: [
        { id: "clean", type: "tool", tool: "text.clean_transcript" },
        { id: "extract", type: "agent", handler: "extract_meeting", agent: { id: "ops-bot", role: "Researcher", budgetUsd: 5 } },
        { id: "context", type: "brain_search", query: "{{extract.customer}} SSO renewal", topK: 5 },
        { id: "gate", type: "eval", policy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.5 } } },
        { id: "decide", type: "condition", predicate: { any: [
          { field: "extract.confidence", op: "<", value: 0.8 },
          { field: "extract.customerSensitive", op: "==", value: true }
        ] } },
        { id: "approve", type: "approval", policy: { triggers: ["customer_comms", "low_confidence"], approvers: ["user:alice"], escalateAfterMinutes: 120, onTimeout: "escalate" } },
        { id: "write", type: "memory_write", memoryType: "decision" },
        { id: "tasks", type: "task", action: "create_tickets" },
        { id: "notify", type: "notify", channel: "slack" },
        { id: "done", type: "end" }
      ],
      edges: [
        { from: "t1", to: "clean" },
        { from: "clean", to: "extract" },
        { from: "extract", to: "context" },
        { from: "context", to: "gate" },
        { from: "gate", to: "decide" },
        { from: "decide", to: "approve", when: "true" },
        { from: "decide", to: "write", when: "false" },
        { from: "approve", to: "write" },
        { from: "write", to: "tasks" },
        { from: "tasks", to: "notify" },
        { from: "notify", to: "done" }
      ],
      permissions: { runAs: "agent", requiredRelations: ["brain#writer"] },
      memoryWritePolicy: { allowedTypes: ["decision", "customer_fact", "risk", "project_update"], minConfidence: 0.6 },
      evalPolicy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.5 } }
    };
    engine.publish(wf);

    // ---- 1. Zoom connector turns a transcript webhook into a trigger ----
    const connectorResult = new ZoomConnector().handle(ORG, sampleZoomTranscript);
    expect(connectorResult.trigger.kind).toBe("zoom_transcript");

    // ---- 2. Trigger the workflow via the MCP gateway (as the ops agent) ----
    const triggerCall = await gateway.callTool(opsAgent, "workflow.trigger", {
      workflowId: wf.id,
      data: connectorResult.trigger.data
    });
    expect(triggerCall.ok).toBe(true);
    const { runId, status } = triggerCall.result as { runId: string; status: string };

    // ---- 3. The run paused at the approval node (customer-sensitive) ----
    expect(status).toBe("paused");
    const pending = governance.listPending(ORG);
    expect(pending).toHaveLength(1);

    // ---- 4. A human approves; the run resumes to completion ----
    governance.decide(pending[0]!.id, alice, "approved", "Reviewed Globex data; ok to record");
    const finished = await engine.resume(runId);
    expect(finished.status).toBe("completed");

    // ---- 5. Effects happened: memory written, ticket created, slack notified ----
    expect(brain.count(ORG)).toBe(1);
    expect(tickets).toHaveLength(1);
    expect(slack).toHaveLength(1);

    // ---- 6. The new context is retrievable via MCP, with provenance ----
    const search = await gateway.callTool(alice, "brain.search", { query: "Globex SSO August" });
    expect(search.ok).toBe(true);
    const hits = search.result as Array<{ title: string; source: { connector: string } }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source.connector).toBe("zoom");

    // ---- 7. Full governance audit trail exists ----
    const actions = audit.list(ORG).map((a) => a.action);
    for (const a of [
      "tool.call:workflow.trigger",
      "approval.requested",
      "eval.run",
      "approval.decide",
      "memory.write",
      "tool.call:brain.search"
    ]) {
      expect(actions, `missing audit action ${a}`).toContain(a);
    }

    // ---- evidence bundle (docs/05 §5): run inspector + audit artifacts ----
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      join(ARTIFACTS, "flagship-run.json"),
      JSON.stringify({ run: finished.nodeLog, status: finished.status, tickets, slack, hits }, null, 2)
    );
    writeFileSync(join(ARTIFACTS, "flagship-audit.json"), JSON.stringify(audit.list(ORG), null, 2));
    writeFileSync(join(ARTIFACTS, "flagship-audit-digest.txt"), audit.digest(ORG));
  });

  it("blocks the run when the eval gate fails (no external effects)", async () => {
    const authz = seedAcme();
    const audit = new InMemoryAudit();
    const brain = new BrainService(authz, audit);
    const governance = new GovernanceService(authz, audit, new BudgetTracker());
    authz.write({ subject: opsAgent.id, relation: "writer", object: `brain:${ORG}` });

    const slack: unknown[] = [];
    const engine = new WorkflowEngine({
      brain,
      governance,
      agents: {
        // extraction with a claim that the (empty) transcript cannot support
        bad_extract: async () => ({ output: { decisions: ["Globex signed a $5M expansion"], confidence: 0.9 }, model: "m", inputTokens: 10, outputTokens: 10 })
      },
      notifiers: { slack: () => { slack.push(1); return {}; } }
    });

    const wf: Workflow = {
      id: "wf_eval_block",
      orgId: ORG,
      name: "eval block",
      version: 1,
      state: "published",
      trigger: { id: "t", type: "trigger", trigger: "manual" },
      nodes: [
        { id: "x", type: "agent", handler: "bad_extract", agent: { id: "ops-bot", role: "R", budgetUsd: 1 } },
        { id: "gate", type: "eval", policy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.7 } } },
        { id: "n", type: "notify", channel: "slack" },
        { id: "done", type: "end" }
      ],
      edges: [{ from: "t", to: "x" }, { from: "x", to: "gate" }, { from: "gate", to: "n" }, { from: "n", to: "done" }],
      permissions: { runAs: "agent", requiredRelations: [] },
      memoryWritePolicy: { allowedTypes: [], minConfidence: 0 },
      evalPolicy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.7 } }
    };

    const run = await engine.start(engine.publish(wf), opsAgent, { transcript: "" });
    expect(run.status).toBe("failed");
    expect(slack).toHaveLength(0); // external effect blocked by the gate
  });
});
