/**
 * Demo-org seed for dev/local. In production the real tenant path (T2.3) creates
 * orgs/users/relations; this keeps the single-tenant MVP + e2e runnable. Gated
 * by SEED_DEMO (on by default for memory/sqlite, off for postgres).
 */
import { principalFromClaims, type AuthzEngine, type Principal } from "@companyos/auth";
import type { BrainService } from "@companyos/brain";
import type { AgentRegistry } from "@companyos/agent-registry";
import type { SkillRegistry } from "@companyos/skill-registry";
import type { Workflow } from "@companyos/dsl";

export function demoPrincipals(org: string): { user: Principal; opsAgent: Principal } {
  return {
    user: principalFromClaims(
      { sub: "alice", org_id: org, realm_access: { roles: ["admin"] }, groups: ["leadership"] },
      org
    ),
    opsAgent: principalFromClaims({ sub: "ops-bot", org_id: org, realm_access: { roles: ["agent"] } }, org)
  };
}

export function flagshipWorkflow(org: string): Workflow {
  return {
    id: "wf_zoom_to_brain",
    orgId: org,
    name: "Zoom transcript → company brain",
    version: 3,
    state: "published",
    trigger: { id: "t1", type: "trigger", trigger: "zoom_transcript" },
    nodes: [
      { id: "clean", type: "tool", tool: "text.clean_transcript" },
      { id: "extract", type: "agent", handler: "extract_meeting", agent: { id: "ops-bot", role: "Researcher", budgetUsd: 5 } },
      { id: "context", type: "brain_search", query: "{{extract.customer}} SSO renewal", topK: 5 },
      { id: "gate", type: "eval", policy: { evals: ["source_coverage"], gate: "block", thresholds: { source_coverage: 0.5 } } },
      { id: "decide", type: "condition", predicate: { any: [{ field: "extract.confidence", op: "<", value: 0.8 }, { field: "extract.customerSensitive", op: "==", value: true }] } },
      { id: "approve", type: "approval", policy: { triggers: ["customer_comms"], approvers: ["user:alice"], escalateAfterMinutes: 120, onTimeout: "escalate" } },
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
}

export function seedDemoOrg(deps: {
  org: string;
  authz: AuthzEngine;
  brain: BrainService;
  agents: AgentRegistry;
  skills: SkillRegistry;
  user: Principal;
  opsAgent: Principal;
}): void {
  const { org, authz, brain, agents, skills, user, opsAgent } = deps;

  authz.write({ subject: user.id, relation: "admin", object: `org:${org}` });
  authz.write({ subject: opsAgent.id, relation: "member", object: `org:${org}` });
  authz.write({ subject: `org:${org}`, relation: "parent", object: `brain:${org}` });
  authz.write({ subject: opsAgent.id, relation: "writer", object: `brain:${org}` });
  authz.write({ subject: opsAgent.id, relation: "trigger", object: "workflow:wf_zoom_to_brain" });

  brain.ingest({ orgId: org, source: { connector: "notion", externalId: "icp", url: "https://notion.so/icp" }, title: "Ideal Customer Profile", content: "Our ICP is mid-market industrial and robotics companies, 100-1000 headcount, who need SSO and SOC2 for expansion." });
  brain.ingest({ orgId: org, source: { connector: "github", externalId: "sso-epic", url: "https://github.com/acme/app/issues/42" }, title: "Epic: SSO support", content: "Engineering plan to deliver SSO (SAML + OIDC) targeting the August release." });
  brain.ingest({ orgId: org, source: { connector: "google_drive", externalId: "q3-board", url: "https://drive.google.com/q3" }, title: "Q3 board update", content: "Pipeline strong; Globex renewal in progress; SSO is the top enterprise blocker.", sourceAcl: { allow: ["group:leadership"] } });

  agents.create({ orgId: org, name: "Atlas", role: "CEO", goal: "Set company strategy and approve major decisions" });
  const pm = agents.create({ orgId: org, name: "Pippa", role: "PM", goal: "Drive the SSO release to GA" });
  agents.create({ orgId: org, name: "Echo", role: "Researcher", goal: "Turn meetings into structured company memory", managerAgentId: pm.id });
  agents.create({ orgId: org, name: "Sandy", role: "Sales", goal: "Qualify and progress enterprise deals" });

  skills.register(
    { orgId: org, name: "qualify-lead", owner: "sales-ops", source: "github", sourceRef: "skills/sales/qualify-lead", description: "Score an inbound lead against ICP and route it", allowedRoles: ["sales", "admin"] },
    { SKILL_md: "# Qualify Lead", tools_json: { inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredTools: ["brain.search"] }, evals_yaml: { evals: ["source_coverage", "factuality"], thresholds: { source_coverage: 0.7, factuality: 0.7 }, gate: "block" } }
  );
}
