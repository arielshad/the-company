/**
 * CorePlatform — the server of record (modular monolith, ADR-0008). The
 * browser-side `apps/web/.../platform.ts` instantiated every service in the tab;
 * this composes the SAME services server-side behind injected durable adapters,
 * with all authorization + audit enforced here. The HTTP API and MCP server are
 * thin transports over this object.
 */
import { BrainService, type MemoryStore, type IngestInput, type SearchHit } from "@companyos/brain";
import { GovernanceService, type ApprovalRequest } from "@companyos/governance";
import { AgentRegistry } from "@companyos/agent-registry";
import { SkillRegistry } from "@companyos/skill-registry";
import { WorkflowEngine, type RunRecord, type AgentHandler } from "@companyos/workflow-engine";
import { McpGateway } from "@companyos/gateway";
import { cleanTranscript, ConnectorRegistry, ZoomConnector } from "@companyos/connectors";
import { BudgetTracker, type AuditSink } from "@companyos/telemetry";
import type { AuthzEngine, Principal } from "@companyos/auth";
import type { AuditRecord } from "@companyos/schemas";
import { canvasToDsl, type Canvas, type Workflow } from "@companyos/dsl";
import type { CoreConfig } from "./config.js";
import { createAgentHandlers } from "./agent-provider.js";
import { createInMemoryEffects, type EffectHandlers } from "./effects.js";
import { demoPrincipals, flagshipWorkflow, seedDemoOrg } from "./seed.js";

export interface ConnectorInfo {
  name: string;
  label: string;
  category: string;
  connected: boolean;
  lastSyncAt?: string;
}

export interface CorePlatformDeps {
  config: CoreConfig;
  authz: AuthzEngine;
  audit: AuditSink;
  memoryStore: MemoryStore;
  agentHandlers?: Record<string, AgentHandler>;
  effects?: EffectHandlers;
}

export class CorePlatform {
  readonly config: CoreConfig;
  readonly authz: AuthzEngine;
  readonly audit: AuditSink;
  readonly budget = new BudgetTracker();
  readonly brain: BrainService;
  readonly governance: GovernanceService;
  readonly agents: AgentRegistry;
  readonly skills: SkillRegistry;
  readonly engine: WorkflowEngine;
  readonly gateway: McpGateway;
  readonly effects: EffectHandlers;

  readonly workflows = new Map<string, Workflow>();
  readonly connectorRegistry = new ConnectorRegistry();
  connectors: ConnectorInfo[] = [];
  /** Agent principal workflows run as when triggered by a connector event. */
  private runAsAgent?: Principal;

  constructor(deps: CorePlatformDeps) {
    this.config = deps.config;
    this.authz = deps.authz;
    this.audit = deps.audit;
    this.effects = deps.effects ?? createInMemoryEffects();
    const agentHandlers = deps.agentHandlers ?? createAgentHandlers({ apiKey: deps.config.anthropicApiKey });

    this.brain = new BrainService(this.authz, this.audit, deps.memoryStore);
    this.governance = new GovernanceService(this.authz, this.audit, this.budget);
    this.agents = new AgentRegistry(this.budget);
    this.skills = new SkillRegistry();
    this.engine = new WorkflowEngine({
      brain: this.brain,
      governance: this.governance,
      tools: {
        "text.clean_transcript": (_n, ctx) => ({ text: cleanTranscript(String((ctx.input as any)?.transcript ?? "")) })
      },
      agents: agentHandlers,
      tasks: this.effects.tasks,
      notifiers: this.effects.notifiers
    });
    this.gateway = new McpGateway({
      authz: this.authz,
      governance: this.governance,
      brain: this.brain,
      engine: this.engine,
      skills: this.skills,
      getWorkflow: (id) => this.workflows.get(id),
      defaultOrg: this.config.defaultOrg
    });
    this.connectorRegistry.register(new ZoomConnector());
  }

  /**
   * Inbound connector event (webhook/poll): parse → ingest with provenance →
   * fire any workflow whose trigger matches the emitted trigger kind. The
   * workflow runs as the configured run-as agent (the only principal granted
   * `trigger`), never as the unauthenticated webhook caller. Idempotent ingest
   * (brain.ingest dedupes on connector+externalId) means a duplicate webhook is
   * safe; effect idempotency (effects.ts) covers the outbound side.
   */
  async handleConnectorEvent(name: string, orgId: string, raw: unknown): Promise<{ itemId: string; deduped: boolean; runId?: string; status?: string }> {
    const result = this.connectorRegistry.handle(name, orgId, raw);
    const ingest = this.brain.ingest(result.ingest);
    let runId: string | undefined;
    let status: string | undefined;
    const agent = this.runAsAgent;
    if (agent) {
      const wf = [...this.workflows.values()].find((w) => w.orgId === orgId && w.trigger.trigger === result.trigger.kind);
      if (wf) {
        const run = await this.engine.start(wf, agent, result.trigger.data);
        runId = run.id;
        status = run.status;
      }
    }
    return { itemId: ingest.itemId, deduped: ingest.deduped, runId, status };
  }

  /** Seed the demo org + flagship workflow (dev/local). */
  seedDemo(): { user: Principal; opsAgent: Principal } {
    const org = this.config.defaultOrg;
    const { user, opsAgent } = demoPrincipals(org);
    seedDemoOrg({ org, authz: this.authz, brain: this.brain, agents: this.agents, skills: this.skills, user, opsAgent });
    this.runAsAgent = opsAgent;
    this.connectors = [
      { name: "notion", label: "Notion", category: "Docs & wiki", connected: true, lastSyncAt: new Date(Date.now() - 36e5).toISOString() },
      { name: "google_drive", label: "Google Drive", category: "Files", connected: true, lastSyncAt: new Date(Date.now() - 72e5).toISOString() },
      { name: "github", label: "GitHub", category: "Code & PRs", connected: true, lastSyncAt: new Date(Date.now() - 18e5).toISOString() },
      { name: "slack", label: "Slack", category: "Chat", connected: false },
      { name: "zoom", label: "Zoom", category: "Meetings", connected: true, lastSyncAt: new Date(Date.now() - 6e5).toISOString() },
      { name: "jira", label: "Jira", category: "Tickets", connected: false }
    ];
    const wf = flagshipWorkflow(org);
    this.workflows.set(wf.id, wf);
    this.engine.publish(wf);
    return { user, opsAgent };
  }

  /* -------- brain -------- */
  search(principal: Principal, query: string, topK?: number): Promise<SearchHit[]> {
    return this.brain.search(principal, { orgId: principal.orgId, query, topK });
  }
  ingest(input: IngestInput) {
    return this.brain.ingest(input);
  }

  /* -------- agents -------- */
  listAgents(orgId: string) {
    return this.agents.list(orgId);
  }
  orgChart(orgId: string) {
    return this.agents.orgChart(orgId);
  }

  /* -------- skills -------- */
  listSkills(orgId: string, role?: string) {
    return this.skills.list(orgId, role ? { role } : undefined);
  }

  /* -------- workflows / runs -------- */
  listWorkflows(orgId: string): Workflow[] {
    return [...this.workflows.values()].filter((w) => w.orgId === orgId);
  }
  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }
  publishWorkflow(wf: Workflow): Workflow {
    const validated = this.engine.publish(wf);
    this.workflows.set(validated.id, validated);
    return validated;
  }
  compile(canvas: Canvas, meta: Pick<Workflow, "id" | "orgId" | "name">) {
    return canvasToDsl(canvas, meta);
  }
  async runWorkflow(id: string, principal: Principal, triggerData?: Record<string, unknown>): Promise<RunRecord> {
    const wf = this.workflows.get(id);
    if (!wf) throw new Error(`unknown workflow ${id}`);
    return this.engine.start(wf, principal, triggerData);
  }
  getRun(id: string): RunRecord | undefined {
    return this.engine.getRun(id);
  }

  /* -------- governance -------- */
  listPendingApprovals(orgId: string): ApprovalRequest[] {
    return this.governance.listPending(orgId);
  }
  async decideApproval(id: string, approver: Principal, decision: "approved" | "rejected", rationale?: string) {
    const approval = this.governance.decide(id, approver, decision, rationale);
    // Resume the paused run now that the gate is resolved (T1.3). The run only
    // advances past the approval node on "approved"; effects past the gate run
    // exactly once because resume continues from resumeFrom (not from start).
    const run = this.engine.findRunByApproval(id);
    if (run) await this.engine.resume(run.id);
    return approval;
  }
  listRuns(orgId: string): RunRecord[] {
    return this.engine.listRuns(orgId);
  }

  auditLog(orgId: string): AuditRecord[] {
    return this.audit.list(orgId).slice().reverse();
  }
  auditDigest(orgId: string): string {
    return this.audit.digest(orgId);
  }
  budgetSpent(agentId: string): number {
    return this.budget.spent(agentId);
  }
  listConnectors(): ConnectorInfo[] {
    return this.connectors;
  }
}

export type { Principal, ApprovalRequest, AuditRecord, Workflow, RunRecord };
