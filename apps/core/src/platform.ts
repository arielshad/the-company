/**
 * CorePlatform — the server of record (modular monolith, ADR-0008). The
 * browser-side `apps/web/.../platform.ts` instantiated every service in the tab;
 * this composes the SAME services server-side behind injected durable adapters,
 * with all authorization + audit enforced here. The HTTP API and MCP server are
 * thin transports over this object.
 */
import { BrainService, OpenAiCompatibleEmbedder, InMemoryMemoryGraph, type MemoryStore, type IngestInput, type SearchHit } from "@companyos/brain";
import { GovernanceService, type ApprovalRequest } from "@companyos/governance";
import { AgentRegistry } from "@companyos/agent-registry";
import { SkillRegistry } from "@companyos/skill-registry";
import { WorkflowEngine, type RunRecord, type AgentHandler } from "@companyos/workflow-engine";
import { McpGateway } from "@companyos/gateway";
import {
  cleanTranscript,
  ConnectorRegistry,
  ZoomConnector,
  NotionConnector,
  GoogleDriveConnector,
  GitHubConnector,
  GmailConnector,
  GoogleCalendarConnector
} from "@companyos/connectors";
import type { SourceConnector, SyncContext } from "@companyos/connectors";
import { BudgetTracker, type AuditSink } from "@companyos/telemetry";
import type { AuthzEngine, Principal } from "@companyos/auth";
import type { AuditRecord } from "@companyos/schemas";
import { canvasToDsl, type Canvas, type Workflow } from "@companyos/dsl";
import type { CoreConfig } from "./config.js";
import { createAgentHandlers } from "./agent-provider.js";
import { createLlmJudges } from "./judges.js";
import { createEntityExtractor } from "./entity-extractor.js";
import { createEffects, effectClientsFromConfig, type EffectHandlers } from "./effects.js";
import { demoPrincipals, flagshipWorkflow, seedDemoOrg } from "./seed.js";

export interface ConnectorInfo {
  name: string;
  label: string;
  category: string;
  connected: boolean;
  lastSyncAt?: string;
  /** True when the row is seeded demo data, not a live external link (trust UX). */
  demo?: boolean;
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
  private readonly sourceConnectors = new Map<string, SourceConnector>();
  connectors: ConnectorInfo[] = [];
  /** Agent principal workflows run as when triggered by a connector event. */
  private runAsAgent?: Principal;

  constructor(deps: CorePlatformDeps) {
    this.config = deps.config;
    this.authz = deps.authz;
    this.audit = deps.audit;
    this.effects = deps.effects ?? createEffects(effectClientsFromConfig(this.config));
    const agentHandlers = deps.agentHandlers ?? createAgentHandlers({ apiKey: deps.config.anthropicApiKey });

    const embedder = this.config.embeddings ? new OpenAiCompatibleEmbedder(this.config.embeddings) : undefined;
    const graph = new InMemoryMemoryGraph();
    const extractor = createEntityExtractor({ apiKey: this.config.anthropicApiKey });
    this.brain = new BrainService(this.authz, this.audit, deps.memoryStore, embedder, graph, extractor);
    const judges = createLlmJudges({ apiKey: this.config.anthropicApiKey });
    this.governance = new GovernanceService(this.authz, this.audit, this.budget, judges);
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
    // Source (OAuth/backfill) connectors — registered when their creds are set.
    if (this.config.notion) this.sourceConnectors.set("notion", new NotionConnector(this.config.notion));
    if (this.config.googleDrive) this.sourceConnectors.set("google_drive", new GoogleDriveConnector(this.config.googleDrive));
    if (this.config.github) this.sourceConnectors.set("github", new GitHubConnector(this.config.github));
    if (this.config.gmail) this.sourceConnectors.set("gmail", new GmailConnector(this.config.gmail));
    if (this.config.googleCalendar) this.sourceConnectors.set("google_calendar", new GoogleCalendarConnector(this.config.googleCalendar));
  }

  /**
   * Source-connector backfill/incremental → brain ingest. Pulls pages from a
   * read connector (e.g. Notion) and ingests each with provenance + source ACL.
   * Idempotent: `brain.ingest` dedupes on connector+externalId, so a re-run
   * updates in place rather than duplicating. `fetchFn` is injectable for tests.
   */
  async backfillSource(
    name: string,
    accessToken: string,
    opts: { orgId?: string; since?: string; fetchFn?: typeof fetch } = {}
  ): Promise<{ ingested: number; deduped: number }> {
    const connector = this.sourceConnectors.get(name);
    if (!connector) throw new Error(`source connector ${name} not registered`);
    const ctx: SyncContext = { orgId: opts.orgId ?? this.config.defaultOrg, accessToken, fetch: opts.fetchFn };
    const gen =
      opts.since && connector.incremental
        ? connector.incremental(ctx, opts.since)
        : connector.backfill?.(ctx);
    if (!gen) throw new Error(`source connector ${name} does not support backfill`);
    let ingested = 0;
    let deduped = 0;
    for await (const payload of gen) {
      const r = this.brain.ingest(payload);
      ingested++;
      if (r.deduped) {
        deduped++;
      } else {
        await this.brain.indexEpisode({
          orgId: ctx.orgId,
          text: payload.content,
          at: new Date().toISOString(),
          source: payload.source
        });
      }
    }
    return { ingested, deduped };
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
    // Index the episode into the temporal memory graph (FR-3.3). Idempotent on
    // re-ingest; non-blocking to the trigger logic below if it fails.
    if (!ingest.deduped) {
      await this.brain.indexEpisode({
        orgId,
        text: result.ingest.content,
        at: new Date().toISOString(),
        source: result.ingest.source
      });
    }
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
    // Honest demo states (no fictional "connected · synced" — see MVP-GAP §8).
    // `connected` reflects whether the connector is actually OAuth-configured;
    // `demo: true` marks a seeded row that is NOT a live external link.
    const cfg = this.config;
    const card = (name: string, label: string, category: string, wired: boolean): ConnectorInfo => ({
      name,
      label,
      category,
      connected: wired,
      demo: !wired
    });
    this.connectors = [
      card("notion", "Notion", "Docs & wiki", Boolean(cfg.notion)),
      card("google_drive", "Google Drive", "Files", Boolean(cfg.googleDrive)),
      card("github", "GitHub", "Code & PRs", Boolean(cfg.github)),
      card("gmail", "Gmail", "Email", Boolean(cfg.gmail)),
      card("google_calendar", "Google Calendar", "Calendar", Boolean(cfg.googleCalendar)),
      card("slack", "Slack", "Chat", Boolean(cfg.slack)),
      card("zoom", "Zoom", "Meetings", true), // real webhook connector (always registered)
      card("jira", "Jira", "Tickets", Boolean(cfg.jira))
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
