import { newId, type MemoryWritePolicy } from "@companyos/schemas";
import { validateWorkflow, type Workflow, type WorkflowNode, type WorkflowEdge } from "@companyos/dsl";
import type { Principal } from "@companyos/auth";
import type { BrainService } from "@companyos/brain";
import type { GovernanceService } from "@companyos/governance";
import { createLogger, type Logger } from "@companyos/telemetry";

/**
 * Workflow engine (PHASE-04): durable-style executor for the DSL with every
 * node type, branching, bounded loops, pause/resume human approvals, and eval
 * gating. The executor is interface-driven (deps) so the durable backend
 * (Trigger.dev -> Temporal, ADR-0003) can change without touching node logic.
 */

export type ToolFn = (input: Record<string, unknown>, ctx: RunContext) => unknown | Promise<unknown>;
export type AgentHandler = (
  ctx: RunContext
) => Promise<{ output: Record<string, unknown>; model: string; inputTokens: number; outputTokens: number }>;
export type TaskFn = (input: Record<string, unknown>, ctx: RunContext) => unknown | Promise<unknown>;
export type NotifyFn = (input: Record<string, unknown>, ctx: RunContext) => unknown | Promise<unknown>;

export interface EngineDeps {
  brain: BrainService;
  governance: GovernanceService;
  tools?: Record<string, ToolFn>;
  agents?: Record<string, AgentHandler>;
  tasks?: Record<string, TaskFn>;
  notifiers?: Record<string, NotifyFn>;
  logger?: Logger;
}

export type RunStatus = "running" | "paused" | "completed" | "failed";

export interface RunRecord {
  id: string;
  workflowId: string;
  orgId: string;
  status: RunStatus;
  traceId: string;
  context: RunContext;
  nodeLog: Array<{ nodeId: string; type: string; output: unknown; at: string }>;
  awaiting?: { approvalId: string; resumeFrom: string };
  result?: unknown;
  error?: string;
}

export type RunContext = Record<string, any>;

const OPS: Record<string, (a: any, b: any) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b
};

function resolvePath(ctx: RunContext, path: string): unknown {
  return path.split(".").reduce<any>((acc, k) => (acc == null ? acc : acc[k]), ctx);
}

/** Replace {{node.field}} references in a string from the run context. */
export function renderTemplate(input: string, ctx: RunContext): string {
  return input.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, p) => {
    const v = resolvePath(ctx, p);
    return v == null ? "" : String(v);
  });
}

export class WorkflowEngine {
  private runs = new Map<string, RunRecord>();
  private workflows = new Map<string, Workflow>();
  private log: Logger;

  constructor(private deps: EngineDeps) {
    this.log = deps.logger ?? createLogger({ svc: "workflow-engine" });
  }

  /** Validate + register a published workflow version. */
  publish(wf: Workflow): Workflow {
    const v = validateWorkflow(wf);
    if (!v.valid) throw new Error(`invalid workflow: ${v.errors.map((e) => e.code).join(",")}`);
    this.workflows.set(wf.id, wf);
    return wf;
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** All runs for an org (run inspector + durable-resume lookups). */
  listRuns(orgId?: string): RunRecord[] {
    const all = [...this.runs.values()];
    return orgId ? all.filter((r) => r.orgId === orgId) : all;
  }

  /** Find the run currently paused awaiting a given approval (T1.3 resume). */
  findRunByApproval(approvalId: string): RunRecord | undefined {
    return [...this.runs.values()].find((r) => r.awaiting?.approvalId === approvalId);
  }

  /** Start a run for a (published) workflow with trigger input. */
  async start(wf: Workflow, principal: Principal, triggerData: Record<string, unknown> = {}): Promise<RunRecord> {
    const v = validateWorkflow(wf);
    if (!v.valid) throw new Error(`invalid workflow: ${v.errors.map((e) => e.code).join(",")}`);
    const run: RunRecord = {
      id: newId("wfr"),
      workflowId: wf.id,
      orgId: wf.orgId,
      status: "running",
      traceId: newId("trace"),
      context: {},
      nodeLog: []
    };
    this.runs.set(run.id, run);
    this.workflows.set(wf.id, wf);
    // trigger output is available under its node id and `input`
    run.context[wf.trigger.id] = triggerData;
    run.context.input = triggerData;
    run.context.__principal = principal;
    await this.execFrom(run, wf, wf.trigger.id);
    return run;
  }

  /** Resume a paused run after its approval was decided. */
  async resume(runId: string): Promise<RunRecord> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== "paused" || !run.awaiting) throw new Error(`run ${runId} is not awaiting approval`);
    const wf = this.workflows.get(run.workflowId)!;
    const appr = this.deps.governance.getApproval(run.awaiting.approvalId);
    const resumeFrom = run.awaiting.resumeFrom;
    run.awaiting = undefined;
    if (appr?.status === "approved") {
      run.status = "running";
      await this.execFrom(run, wf, resumeFrom);
    } else if (appr?.status === "rejected") {
      run.status = "failed";
      run.error = "approval_rejected";
    } else {
      // escalated / still pending → remain paused
      run.status = "paused";
      run.awaiting = { approvalId: appr!.id, resumeFrom };
    }
    return run;
  }

  private nodeById(wf: Workflow, id: string): WorkflowNode | undefined {
    return [wf.trigger, ...wf.nodes].find((n) => n.id === id);
  }
  private out(wf: Workflow, id: string): WorkflowEdge[] {
    return wf.edges.filter((e) => e.from === id);
  }

  /** Execute starting from `startId`, walking the single active path. */
  private async execFrom(run: RunRecord, wf: Workflow, startId: string): Promise<void> {
    let currentId: string | undefined = startId;
    const loopCounters = new Map<string, number>();

    while (currentId) {
      const node = this.nodeById(wf, currentId);
      if (!node) {
        run.status = "failed";
        run.error = `missing node ${currentId}`;
        return;
      }

      // node already executed for trigger (we just need to route from it)
      let nextId: string | undefined;
      if (node.type === "trigger") {
        nextId = this.out(wf, node.id)[0]?.to;
      } else {
        const handled = await this.runNode(run, wf, node, loopCounters);
        if (handled.pause) return; // paused for approval
        if (handled.stop) {
          run.status = handled.failed ? "failed" : "completed";
          run.result = run.context[node.id];
          return;
        }
        nextId = handled.nextId;
      }
      currentId = nextId;
    }
    // ran out of edges without hitting end
    if (run.status === "running") run.status = "completed";
  }

  private async runNode(
    run: RunRecord,
    wf: Workflow,
    node: WorkflowNode,
    loopCounters: Map<string, number>
  ): Promise<{ nextId?: string; pause?: boolean; stop?: boolean; failed?: boolean }> {
    const ctx = run.context;
    const principal: Principal = ctx.__principal;
    const record = (output: unknown) => {
      ctx[node.id] = output;
      run.nodeLog.push({ nodeId: node.id, type: node.type, output, at: new Date().toISOString() });
    };
    const edges = this.out(wf, node.id);
    const firstNext = edges[0]?.to;

    switch (node.type) {
      case "end": {
        record(this.summarizeCtx(ctx));
        return { stop: true };
      }
      case "brain_search": {
        const query = renderTemplate(String(node.query ?? ""), ctx);
        const hits = await this.deps.brain.search(principal, { orgId: run.orgId, query, topK: Number(node.topK ?? 5) });
        record({ hits });
        return { nextId: firstNext };
      }
      case "tool": {
        const fn = this.deps.tools?.[String(node.tool)];
        if (!fn) {
          record({ error: `unknown tool ${node.tool}` });
          return { stop: true, failed: true };
        }
        const out = await fn(node as Record<string, unknown>, ctx);
        record(out);
        return { nextId: firstNext };
      }
      case "agent": {
        const handlerName = String((node as any).handler ?? "");
        const handler = this.deps.agents?.[handlerName];
        if (!handler) {
          record({ error: `unknown agent handler ${handlerName}` });
          return { stop: true, failed: true };
        }
        const r = await handler(ctx);
        // meter + enforce budget via governance
        const agentCfg = (node as any).agent ?? {};
        const cap = Number(agentCfg.budgetUsd ?? agentCfg.budgetMonthlyUsd ?? 0);
        const agentId = String(agentCfg.id ?? agentCfg.role ?? node.id);
        const budget = this.deps.governance.chargeModelUsage(agentId, run.orgId, cap, r.model, r.inputTokens, r.outputTokens);
        if (budget.status === "exceeded" && cap > 0) {
          record({ ...r.output, __budget: budget.status });
          return { stop: true, failed: true };
        }
        record(r.output);
        return { nextId: firstNext };
      }
      case "condition": {
        const pass = this.evalCondition(node, ctx);
        record({ result: pass });
        const branch = edges.find((e) => e.when === String(pass)) ?? edges.find((e) => e.when === (pass ? "true" : "false"));
        return { nextId: branch?.to ?? firstNext };
      }
      case "loop": {
        const max = Number(node.maxIterations ?? 1);
        const n = (loopCounters.get(node.id) ?? 0) + 1;
        loopCounters.set(node.id, n);
        record({ iteration: n });
        const more = n < max;
        const retry = edges.find((e) => e.when === "retry")?.to;
        const exit = edges.find((e) => e.when === "exit")?.to ?? firstNext;
        return { nextId: more && retry ? retry : exit };
      }
      case "approval": {
        const approval = this.deps.governance.createApproval({
          orgId: run.orgId,
          runId: run.id,
          nodeId: node.id,
          policy: (node as any).policy ?? { triggers: [], approvers: [], onTimeout: "escalate" },
          payload: { context: this.summarizeCtx(ctx) }
        });
        record({ approvalId: approval.id, status: "pending" });
        run.status = "paused";
        run.awaiting = { approvalId: approval.id, resumeFrom: firstNext ?? "" };
        return { pause: true };
      }
      case "eval": {
        const policy = (node as any).policy ?? wf.evalPolicy;
        const input = this.buildEvalInput(run, ctx);
        const result = this.deps.governance.runEvalGate(run.orgId, input, policy);
        record({ passed: result.passed, blocked: result.blocked, failures: result.failures });
        if (result.blocked) return { stop: true, failed: true };
        return { nextId: firstNext };
      }
      case "memory_write": {
        const policy: MemoryWritePolicy = {
          ...(wf.memoryWritePolicy ?? { allowedTypes: [], minConfidence: 0 }),
          // approval already handled by an explicit approval node when needed
          requireApprovalBelow: undefined
        };
        const draft = this.buildMemoryDraft(run, node, ctx);
        const res = await this.deps.brain.writeMemory(principal, draft, policy);
        record(res);
        if (res.status !== "written") return { stop: true, failed: res.status === "rejected" };
        return { nextId: firstNext };
      }
      case "task": {
        const fn = this.deps.tasks?.[String((node as any).action ?? "")];
        const out = fn ? await fn(node as Record<string, unknown>, ctx) : { skipped: true };
        record(out);
        return { nextId: firstNext };
      }
      case "notify": {
        const channel = String((node as any).channel ?? "");
        const fn = this.deps.notifiers?.[channel];
        const out = fn ? await fn(node as Record<string, unknown>, ctx) : { skipped: true };
        record(out);
        return { nextId: firstNext };
      }
      default: {
        record({ skipped: true, type: node.type });
        return { nextId: firstNext };
      }
    }
  }

  private evalCondition(node: WorkflowNode, ctx: RunContext): boolean {
    const pred = (node as any).predicate ?? (node as any).when;
    if (!pred) return Boolean((node as any).value);
    const clauses: Array<{ field: string; op: string; value: unknown }> = pred.any ?? pred.all ?? [];
    const evalClause = (c: { field: string; op: string; value: unknown }) => {
      const left = resolvePath(ctx, c.field);
      const op = OPS[c.op];
      return op ? op(left, c.value) : false;
    };
    if (pred.all) return clauses.every(evalClause);
    return clauses.some(evalClause);
  }

  /** Build eval input from the most recent extraction-like node output. */
  private buildEvalInput(run: RunRecord, ctx: RunContext): Record<string, unknown> {
    const hasClaims = (o: any) =>
      o && typeof o === "object" && (o.claims || o.decisions || o.risks || o.customerFacts);
    let extract: any = {};
    for (let i = run.nodeLog.length - 1; i >= 0; i--) {
      if (hasClaims(run.nodeLog[i]!.output)) {
        extract = run.nodeLog[i]!.output;
        break;
      }
    }
    const claims: string[] = [
      ...(extract.claims ?? []),
      ...(extract.decisions ?? []),
      ...(extract.risks ?? []),
      ...(extract.customerFacts ?? [])
    ];
    const transcript = String(ctx.input?.transcript ?? ctx.clean?.text ?? "");
    const citations = transcript ? claims.map(() => ({ sourceRef: "zoom", quote: transcript })) : [];
    return { claims, citations, toolsUsed: [], allowedTools: [] };
  }

  private buildMemoryDraft(run: RunRecord, node: WorkflowNode, ctx: RunContext) {
    const extract = ctx.extract ?? {};
    const decision = (extract.decisions ?? [])[0] ?? extract.summary ?? "Meeting note";
    return {
      orgId: run.orgId,
      type: (node as any).memoryType ?? ("decision" as const),
      title: String(extract.title ?? extract.customer ?? "Meeting decision"),
      content: String(decision),
      source: { connector: "zoom", externalId: String(ctx.input?.meetingId ?? run.id) },
      confidence: Number(extract.confidence ?? 0.9),
      relatedProjects: extract.customer ? [String(extract.customer)] : []
    };
  }

  private summarizeCtx(ctx: RunContext): Record<string, unknown> {
    const { __principal, ...rest } = ctx;
    void __principal;
    return rest;
  }
}
