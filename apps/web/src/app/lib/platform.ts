import { InMemoryAuthz, principalFromClaims, type Principal } from "@companyos/auth";
import { InMemoryAudit, BudgetTracker } from "@companyos/telemetry";
import type { AuditRecord } from "@companyos/schemas";
import { BrainService } from "@companyos/brain";
import { GovernanceService, type ApprovalRequest } from "@companyos/governance";
import { AgentRegistry } from "@companyos/agent-registry";
import { SkillRegistry } from "@companyos/skill-registry";
import { WorkflowEngine } from "@companyos/workflow-engine";
import { McpGateway } from "@companyos/gateway";
import { ZoomConnector, cleanTranscript } from "@companyos/connectors";
import type { Workflow } from "@companyos/dsl";

/**
 * Live in-browser CompanyOS platform: the UI drives the REAL implemented
 * services (auth, brain, governance, workflow engine, gateway, registries) —
 * not mocks. Everything is in-memory and seeded with a realistic demo org so
 * users can actually operate the system end to end.
 */

export const ORG = "acme";

export interface ConnectorInfo {
  name: string;
  label: string;
  category: string;
  connected: boolean;
  lastSyncAt?: string;
}

export interface Ticket {
  id: string;
  summary: string;
  target: string;
}
export interface SlackMsg {
  channel: string;
  text: string;
}

class Platform {
  authz = new InMemoryAuthz();
  audit = new InMemoryAudit();
  budget = new BudgetTracker();
  brain: BrainService;
  governance: GovernanceService;
  agents: AgentRegistry;
  skills: SkillRegistry;
  engine: WorkflowEngine;
  gateway: McpGateway;

  tickets: Ticket[] = [];
  slack: SlackMsg[] = [];
  connectors: ConnectorInfo[] = [];
  workflows = new Map<string, Workflow>();

  /** The signed-in human (Keycloak admin in this demo org). */
  user: Principal = principalFromClaims(
    { sub: "alice", org_id: ORG, realm_access: { roles: ["admin"] }, groups: ["leadership"] },
    ORG
  );
  /** The agent principal that runs workflows. */
  opsAgent: Principal = principalFromClaims(
    { sub: "ops-bot", org_id: ORG, realm_access: { roles: ["agent"] } },
    ORG
  );

  constructor() {
    this.brain = new BrainService(this.authz, this.audit);
    this.governance = new GovernanceService(this.authz, this.audit, this.budget);
    this.agents = new AgentRegistry(this.budget);
    this.skills = new SkillRegistry();
    this.engine = new WorkflowEngine({
      brain: this.brain,
      governance: this.governance,
      tools: {
        "text.clean_transcript": (_n, ctx) => ({ text: cleanTranscript(String(ctx.input?.transcript ?? "")) })
      },
      agents: {
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
          const ticket = { id: `GLOBEX-${this.tickets.length + 1}`, summary: (ctx.extract?.actionItems ?? [])[0] ?? "follow up", target: "jira" };
          this.tickets.push(ticket);
          return ticket;
        }
      },
      notifiers: {
        slack: (_n, ctx) => {
          const msg = { channel: "#team-updates", text: `New decision recorded: ${ctx.extract?.decisions?.[0] ?? "(none)"}` };
          this.slack.push(msg);
          return msg;
        }
      }
    });
    this.gateway = new McpGateway({
      authz: this.authz,
      governance: this.governance,
      brain: this.brain,
      engine: this.engine,
      skills: this.skills,
      getWorkflow: (id) => this.workflows.get(id),
      defaultOrg: ORG
    });
    this.seed();
  }

  private seed() {
    // --- identity / relations ---
    this.authz.write({ subject: this.user.id, relation: "admin", object: `org:${ORG}` });
    this.authz.write({ subject: this.opsAgent.id, relation: "member", object: `org:${ORG}` });
    this.authz.write({ subject: `org:${ORG}`, relation: "parent", object: `brain:${ORG}` });
    this.authz.write({ subject: this.opsAgent.id, relation: "writer", object: `brain:${ORG}` });
    this.authz.write({ subject: this.opsAgent.id, relation: "trigger", object: "workflow:wf_zoom_to_brain" });

    // --- connectors ---
    this.connectors = [
      { name: "notion", label: "Notion", category: "Docs & wiki", connected: true, lastSyncAt: new Date(Date.now() - 36e5).toISOString() },
      { name: "google_drive", label: "Google Drive", category: "Files", connected: true, lastSyncAt: new Date(Date.now() - 72e5).toISOString() },
      { name: "github", label: "GitHub", category: "Code & PRs", connected: true, lastSyncAt: new Date(Date.now() - 18e5).toISOString() },
      { name: "slack", label: "Slack", category: "Chat", connected: false },
      { name: "gmail", label: "Gmail", category: "Email", connected: false },
      { name: "calendar", label: "Google Calendar", category: "Calendar", connected: false },
      { name: "zoom", label: "Zoom", category: "Meetings", connected: true, lastSyncAt: new Date(Date.now() - 6e5).toISOString() },
      { name: "jira", label: "Jira", category: "Tickets", connected: false }
    ];

    // --- seed brain documents (from "connected" sources) ---
    this.brain.ingest({ orgId: ORG, source: { connector: "notion", externalId: "icp", url: "https://notion.so/icp" }, title: "Ideal Customer Profile", content: "Our ICP is mid-market industrial and robotics companies, 100-1000 headcount, who need SSO and SOC2 for expansion." });
    this.brain.ingest({ orgId: ORG, source: { connector: "github", externalId: "sso-epic", url: "https://github.com/acme/app/issues/42" }, title: "Epic: SSO support", content: "Engineering plan to deliver SSO (SAML + OIDC) targeting the August release." });
    this.brain.ingest({ orgId: ORG, source: { connector: "google_drive", externalId: "q3-board", url: "https://drive.google.com/q3" }, title: "Q3 board update", content: "Pipeline strong; Globex renewal in progress; SSO is the top enterprise blocker.", sourceAcl: { allow: ["group:leadership"] } });

    // --- agents ---
    this.agents.create({ orgId: ORG, name: "Atlas", role: "CEO", goal: "Set company strategy and approve major decisions" });
    const pm = this.agents.create({ orgId: ORG, name: "Pippa", role: "PM", goal: "Drive the SSO release to GA" });
    this.agents.create({ orgId: ORG, name: "Echo", role: "Researcher", goal: "Turn meetings into structured company memory", managerAgentId: pm.id });
    this.agents.create({ orgId: ORG, name: "Sandy", role: "Sales", goal: "Qualify and progress enterprise deals" });

    // --- skills ---
    this.skills.register(
      { orgId: ORG, name: "qualify-lead", owner: "sales-ops", source: "github", sourceRef: "skills/sales/qualify-lead", description: "Score an inbound lead against ICP and route it", allowedRoles: ["sales", "admin"] },
      {
        SKILL_md: "# Qualify Lead",
        tools_json: { inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredTools: ["brain.search"] },
        evals_yaml: { evals: ["source_coverage", "factuality"], thresholds: { source_coverage: 0.7, factuality: 0.7 }, gate: "block" }
      }
    );
    this.skills.register(
      { orgId: ORG, name: "investigate-incident", owner: "eng-oncall", source: "github", sourceRef: "skills/engineering/investigate-incident", description: "Triage a production incident from logs + memory", allowedRoles: ["engineering", "admin"] },
      {
        SKILL_md: "# Investigate Incident",
        tools_json: { inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredTools: ["brain.search"] },
        evals_yaml: { evals: ["source_coverage"], thresholds: { source_coverage: 0.6 }, gate: "advisory" }
      }
    );

    // --- the flagship workflow ---
    this.workflows.set("wf_zoom_to_brain", this.flagshipWorkflow());
    this.engine.publish(this.flagshipWorkflow());
  }

  flagshipWorkflow(): Workflow {
    return {
      id: "wf_zoom_to_brain",
      orgId: ORG,
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

  /* ---------------- UI-facing operations ---------------- */

  search(query: string) {
    return this.gateway.callTool(this.user, "brain.search", { query });
  }

  listAgents() {
    return this.agents.list(ORG);
  }

  listPendingApprovals(): ApprovalRequest[] {
    return this.governance.listPending(ORG);
  }

  auditLog(): AuditRecord[] {
    return this.audit.list(ORG).slice().reverse();
  }

  budgetSpent(agentId: string): number {
    return this.budget.spent(agentId);
  }

  connectorHealthy(): number {
    return this.connectors.filter((c) => c.connected).length;
  }
}

export const platform = new Platform();
export type { Principal, ApprovalRequest, AuditRecord, Workflow };
