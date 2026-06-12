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
import { cleanTranscript, ConnectorRegistry, ZoomConnector } from "@companyos/connectors";
import type { SourceConnector, SyncContext } from "@companyos/connectors";
import { CONNECTORS, CONNECTOR_CATALOG, connectorDef, type ConnectorKind } from "./connectors.js";
import { BudgetTracker, makeAuditRecord, type AuditSink } from "@companyos/telemetry";
import type { AuthzEngine, Principal } from "@companyos/auth";
import type { AuditRecord } from "@companyos/schemas";
import { canvasToDsl, type Canvas, type Workflow } from "@companyos/dsl";
import type { CoreConfig } from "./config.js";
import { createAgentHandlers } from "./agent-provider.js";
import { createLlmJudges } from "./judges.js";
import { createEntityExtractor } from "./entity-extractor.js";
import { createEffects, effectClientsFromConfig, type EffectHandlers } from "./effects.js";
import { demoPrincipals, flagshipWorkflow, seedDemoOrg } from "./seed.js";

export type { ConnectorKind };
export { CONNECTOR_CATALOG };

/**
 * Lifecycle of a source connector's ingestion, surfaced to the UI so the
 * "connect → importing → first results" journey has truthful states instead of
 * a frozen green dot (docs/08-ux-experience-guidelines.md). `syncing` carries a
 * live `ingested` count; `error` carries a message + a retryable affordance.
 */
export type ConnectorSyncStatus = "syncing" | "synced" | "error";

export interface ConnectorSyncState {
  status: ConnectorSyncStatus;
  /** Items ingested so far (live during `syncing`, final on `synced`). */
  ingested: number;
  deduped: number;
  startedAt: string;
  finishedAt?: string;
  /** Present only when status is `error`. */
  error?: string;
}

export interface ConnectorInfo {
  name: string;
  label: string;
  category: string;
  kind: ConnectorKind;
  /** OAuth/API creds present in config (can start a real OAuth connect). */
  configured: boolean;
  /** A usable token/route exists for this org (real link, not demo). */
  connected: boolean;
  lastSyncAt?: string;
  /** Live ingestion state for source connectors (undefined until first sync). */
  sync?: ConnectorSyncState;
  /** True when the row is demo-only, not a live external link (trust UX). */
  demo: boolean;
}

export interface CorePlatformDeps {
  config: CoreConfig;
  authz: AuthzEngine;
  audit: AuditSink;
  memoryStore: MemoryStore;
  agentHandlers?: Record<string, AgentHandler>;
  effects?: EffectHandlers;
  /** Default fetch for connector backfills (injectable for tests; else global). */
  fetchFn?: typeof fetch;
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
  /** Per-(org|connector) access token from the connect flow. NEVER serialized to the client. */
  private readonly connectorTokens = new Map<string, string>();
  /** Per-(org|connector) last successful sync timestamp. */
  private readonly connectorLastSync = new Map<string, string>();
  /** Per-(org|connector) live ingestion state (syncing/synced/error) for the UI. */
  private readonly connectorSync = new Map<string, ConnectorSyncState>();
  /** Per-(org|connector) in-flight sync, so concurrent triggers coalesce. */
  private readonly connectorSyncInFlight = new Map<string, Promise<void>>();
  /** Periodic incremental-sync timer (started only by the entrypoint). */
  private syncTimer?: ReturnType<typeof setInterval>;
  /** Default fetch for backfills (injectable for tests). */
  private readonly defaultFetch?: typeof fetch;
  /** Agent principal workflows run as when triggered by a connector event. */
  private runAsAgent?: Principal;

  constructor(deps: CorePlatformDeps) {
    this.config = deps.config;
    this.authz = deps.authz;
    this.audit = deps.audit;
    this.defaultFetch = deps.fetchFn;
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
    // Source connectors are ALWAYS registered (from the single CONNECTORS table)
    // so a token from the connect flow enables backfill even in dev — real OAuth
    // `authorizeUrl`/`exchangeCode` additionally needs creds in config, but
    // backfill only needs the access token. One table → no per-connector wiring.
    for (const def of CONNECTORS) {
      if (def.create) this.sourceConnectors.set(def.name, def.create(this.config));
    }
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
    opts: {
      orgId?: string;
      since?: string;
      fetchFn?: typeof fetch;
      /** Called after each item so callers can surface live progress. */
      onProgress?: (p: { ingested: number; deduped: number }) => void;
    } = {}
  ): Promise<{ ingested: number; deduped: number }> {
    const connector = this.sourceConnectors.get(name);
    if (!connector) throw new Error(`source connector ${name} not registered`);
    const ctx: SyncContext = { orgId: opts.orgId ?? this.config.defaultOrg, accessToken, fetch: opts.fetchFn ?? this.defaultFetch };
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
      opts.onProgress?.({ ingested, deduped });
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
    // A received event marks a webhook connector as live (honest status).
    this.connectorLastSync.set(this.tokenKey(orgId, name), new Date().toISOString());
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
    // Connector status is computed live by listConnectors(orgId) from config +
    // the per-org token store — no fictional "connected · synced" (MVP-GAP §8).
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
  /* ---------------- integrations (connect / backfill / status) ---------------- */

  /** OAuth/API creds present in config for a connector (from the CONNECTORS table). */
  private connectorConfigured(name: string): boolean {
    return connectorDef(name)?.configured(this.config) ?? false;
  }

  private tokenKey(orgId: string, name: string): string {
    return `${orgId}|${name}`;
  }

  /** Live connector catalog + per-org status for the UI. */
  listConnectors(orgId: string): ConnectorInfo[] {
    return CONNECTOR_CATALOG.map((m) => {
      const configured = this.connectorConfigured(m.name);
      const hasToken = this.connectorTokens.has(this.tokenKey(orgId, m.name));
      const hasReceived = this.connectorLastSync.has(this.tokenKey(orgId, m.name));
      let connected: boolean;
      // webhook: only "connected" once it has actually received an event (no
      // fictional green dot — MVP-GAP §8); outbound: a bot token is in config;
      // source: a connect-flow token is stored for this org.
      if (m.kind === "webhook") connected = hasReceived;
      else if (m.kind === "outbound") connected = configured;
      else connected = hasToken;
      return {
        name: m.name,
        label: m.label,
        category: m.category,
        kind: m.kind,
        configured,
        connected,
        demo: !connected,
        lastSyncAt: this.connectorLastSync.get(this.tokenKey(orgId, m.name)),
        sync: this.connectorSync.get(this.tokenKey(orgId, m.name))
      };
    });
  }

  /** Start a real OAuth connect: the URL to redirect the user to (needs creds). */
  connectorAuthorizeUrl(name: string, state: string): string {
    const c = this.sourceConnectors.get(name) as (SourceConnector & { authorizeUrl?: (s: string) => string }) | undefined;
    if (!c?.authorizeUrl) throw new Error(`connector ${name} does not support OAuth`);
    if (!this.connectorConfigured(name)) throw new Error(`connector ${name} is not configured (missing OAuth creds)`);
    return c.authorizeUrl(state);
  }

  /** Finish OAuth: exchange the code for a token and store it for the org. */
  async connectorExchangeCode(name: string, orgId: string, code: string, redirectUri: string): Promise<void> {
    const c = this.sourceConnectors.get(name) as (SourceConnector & { exchangeCode?: (code: string, r: string) => Promise<{ accessToken: string }> }) | undefined;
    if (!c?.exchangeCode) throw new Error(`connector ${name} does not support OAuth`);
    const token = await c.exchangeCode(code, redirectUri);
    this.connectorTokens.set(this.tokenKey(orgId, name), token.accessToken);
    // Connecting a source implies you want its data — kick off the first
    // backfill immediately so "Connect" actually fills the brain (auto-backfill
    // on connect; docs/08-ux-experience-guidelines.md). Non-blocking: the UI
    // polls the `syncing → synced` state.
    void this.triggerSync(name, orgId);
  }

  /** Connect with a directly-supplied access token (dev / PAT path). */
  connectConnectorToken(name: string, orgId: string, accessToken: string): void {
    if (!this.sourceConnectors.has(name)) throw new Error(`source connector ${name} not registered`);
    this.connectorTokens.set(this.tokenKey(orgId, name), accessToken);
    void this.triggerSync(name, orgId);
  }

  /** Disconnect: drop the stored token + all sync state for the org. */
  disconnectConnector(name: string, orgId: string): void {
    const key = this.tokenKey(orgId, name);
    this.connectorTokens.delete(key);
    this.connectorLastSync.delete(key);
    this.connectorSync.delete(key);
  }

  /**
   * Run a backfill for a connected source connector and wait for it. Routes
   * through the tracked sync path, so it coalesces with any in-flight
   * auto-backfill and surfaces the same `syncing/synced/error` state to the UI.
   * Re-throws on failure so the manual "Backfill" button can show the error.
   */
  async backfillConnector(name: string, orgId: string, opts: { since?: string } = {}): Promise<{ ingested: number; deduped: number }> {
    const key = this.tokenKey(orgId, name);
    if (!this.connectorTokens.has(key)) throw new Error(`connector ${name} is not connected for this org`);
    await this.triggerSync(name, orgId, opts);
    const state = this.connectorSync.get(key);
    if (state?.status === "error") throw new Error(state.error ?? `${name} sync failed`);
    return { ingested: state?.ingested ?? 0, deduped: state?.deduped ?? 0 };
  }

  /**
   * Start (or join, if already running) a tracked sync for a connected source.
   * Non-blocking; returns the in-flight promise so callers/tests can await it.
   * Concurrent triggers for the same (org, connector) coalesce onto one run.
   */
  triggerSync(name: string, orgId: string, opts: { since?: string } = {}): Promise<void> {
    const key = this.tokenKey(orgId, name);
    if (!this.sourceConnectors.has(name) || !this.connectorTokens.has(key)) return Promise.resolve();
    const inFlight = this.connectorSyncInFlight.get(key);
    if (inFlight) return inFlight;
    const run = this.runSync(name, orgId, opts).finally(() => this.connectorSyncInFlight.delete(key));
    this.connectorSyncInFlight.set(key, run);
    return run;
  }

  /** Execute one sync, recording syncing → synced/error state as it goes. */
  private async runSync(name: string, orgId: string, opts: { since?: string }): Promise<void> {
    const key = this.tokenKey(orgId, name);
    const token = this.connectorTokens.get(key);
    if (!token) return;
    const startedAt = new Date().toISOString();
    const state: ConnectorSyncState = { status: "syncing", ingested: 0, deduped: 0, startedAt };
    this.connectorSync.set(key, state);
    try {
      const res = await this.backfillSource(name, token, {
        orgId,
        since: opts.since,
        onProgress: (p) => {
          state.ingested = p.ingested;
          state.deduped = p.deduped;
        }
      });
      const finishedAt = new Date().toISOString();
      this.connectorSync.set(key, { status: "synced", ingested: res.ingested, deduped: res.deduped, startedAt, finishedAt });
      this.connectorLastSync.set(key, finishedAt);
    } catch (err) {
      this.connectorSync.set(key, {
        status: "error",
        ingested: state.ingested,
        deduped: state.deduped,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: (err as Error).message
      });
    }
  }

  /**
   * Begin periodic incremental sync of every connected source connector
   * (FR-2.2). Opt-in: only the entrypoint calls this, so tests never spin a
   * timer. Idempotent; the timer is unref'd so it never holds the process open.
   */
  startConnectorScheduler(intervalMs: number): void {
    if (this.syncTimer || intervalMs <= 0) return;
    this.syncTimer = setInterval(() => void this.syncAllConnected(), intervalMs);
    this.syncTimer.unref?.();
  }

  /** Stop the periodic sync timer (clean shutdown / tests). */
  stopConnectorScheduler(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  /** Incrementally sync every (org, connector) that has a stored token. */
  private async syncAllConnected(): Promise<void> {
    for (const key of this.connectorTokens.keys()) {
      const sep = key.indexOf("|");
      const orgId = key.slice(0, sep);
      const name = key.slice(sep + 1);
      const since = this.connectorLastSync.get(key);
      await this.triggerSync(name, orgId, since ? { since } : {});
    }
  }

  /* ---------------- memory graph (FR-3.3) ---------------- */

  graphEntities(orgId: string) {
    return this.brain.graphEntities(orgId);
  }
  graphNeighbors(orgId: string, name: string, asOf?: string) {
    return this.brain.graphNeighbors(orgId, name, asOf ? { asOf } : undefined);
  }

  /* ---------------- tenancy (self-serve org creation) ---------------- */

  /**
   * Create a new org and make `adminId` its admin (FR-1.2). Wires the same
   * authz tuples the demo seed uses so the org is immediately operable + isolated.
   */
  createOrg(orgId: string, adminId: string): { orgId: string } {
    this.authz.write({ subject: adminId, relation: "admin", object: `org:${orgId}` });
    this.authz.write({ subject: `org:${orgId}`, relation: "parent", object: `brain:${orgId}` });
    this.audit.append(makeAuditRecord({
      orgId,
      actor: { type: "user", id: adminId },
      action: "org.create",
      resource: { type: "org", id: `org:${orgId}` },
      decision: "allow"
    }));
    return { orgId };
  }
}

export type { Principal, ApprovalRequest, AuditRecord, Workflow, RunRecord };
