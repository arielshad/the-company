import { newId, type ApprovalPolicy, type EvalPolicy } from "@companyos/schemas";
import { type AuthzEngine, type Principal } from "@companyos/auth";
import {
  type AuditSink,
  type BudgetTracker,
  type BudgetDecision,
  makeAuditRecord,
  meterCostUsd
} from "@companyos/telemetry";
import { runSuite, type EvalInput, type SuiteResult, type Evaluator } from "@companyos/eval-service";

/**
 * Governance (docs/04): the enforcement layer — authorization + audit on every
 * action, human approvals, budget enforcement, and eval gating.
 */

export interface ApprovalRequest {
  id: string;
  orgId: string;
  runId: string;
  nodeId: string;
  policy: ApprovalPolicy;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "escalated";
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
  rationale?: string;
}

export class GovernanceService {
  private approvals = new Map<string, ApprovalRequest>();

  constructor(
    private authz: AuthzEngine,
    private audit: AuditSink,
    private budget: BudgetTracker,
    /** Optional per-eval overrides (e.g. budgeted LLM judges) injected by the server. */
    private evaluators?: Record<string, Evaluator>
  ) {}

  /** Authorize an action and audit the decision (allow/deny). */
  async authorize(
    principal: Principal,
    relation: string,
    object: string,
    action: string,
    traceId?: string
  ): Promise<boolean> {
    const allowed = await this.authz.check(principal.id, relation, object);
    this.audit.append(
      makeAuditRecord({
        orgId: principal.orgId,
        actor: { type: principal.type, id: principal.id },
        action,
        resource: { type: object.split(":")[0]!, id: object },
        decision: allowed ? "allow" : "deny",
        traceId
      })
    );
    return allowed;
  }

  /* ---------------- Approvals (FR-6.6, FR-8.1) ---------------- */

  createApproval(input: Omit<ApprovalRequest, "id" | "status" | "createdAt">): ApprovalRequest {
    const req: ApprovalRequest = {
      ...input,
      id: newId("appr"),
      status: "pending",
      createdAt: Date.now()
    };
    this.approvals.set(req.id, req);
    this.audit.append(
      makeAuditRecord({
        orgId: req.orgId,
        actor: { type: "service", id: "service:workflow-engine" },
        action: "approval.requested",
        resource: { type: "approval", id: req.id }
      })
    );
    return req;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  listPending(orgId: string): ApprovalRequest[] {
    return [...this.approvals.values()].filter((a) => a.orgId === orgId && a.status === "pending");
  }

  decide(id: string, approver: Principal, decision: "approved" | "rejected", rationale?: string): ApprovalRequest {
    const req = this.approvals.get(id);
    if (!req) throw new Error(`approval ${id} not found`);
    if (req.status !== "pending") throw new Error(`approval ${id} already ${req.status}`);
    req.status = decision;
    req.decidedBy = approver.id;
    req.decidedAt = Date.now();
    req.rationale = rationale;
    this.audit.append(
      makeAuditRecord({
        orgId: req.orgId,
        actor: { type: approver.type, id: approver.id },
        action: "approval.decide",
        resource: { type: "approval", id: req.id },
        decision: decision === "approved" ? "allow" : "deny",
        metadata: { rationale }
      })
    );
    return req;
  }

  /** Apply the timeout policy to a still-pending approval (T04.8). */
  resolveTimeout(id: string, now = Date.now()): ApprovalRequest | undefined {
    const req = this.approvals.get(id);
    if (!req || req.status !== "pending") return req;
    const limit = req.policy.escalateAfterMinutes;
    if (limit === undefined) return req;
    if (now - req.createdAt < limit * 60_000) return req;
    switch (req.policy.onTimeout) {
      case "auto_approve":
        req.status = "approved";
        break;
      case "reject":
        req.status = "rejected";
        break;
      default:
        req.status = "escalated";
    }
    this.audit.append(
      makeAuditRecord({
        orgId: req.orgId,
        actor: { type: "service", id: "service:governance" },
        action: "approval.timeout",
        resource: { type: "approval", id: req.id },
        metadata: { outcome: req.status }
      })
    );
    return req;
  }

  /* ---------------- Budget (FR-4.3, NFR-9) ---------------- */

  chargeModelUsage(
    agentId: string,
    orgId: string,
    cap: number,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): BudgetDecision {
    const cost = meterCostUsd(model, inputTokens, outputTokens);
    const decision = this.budget.record(agentId, cap, cost);
    this.audit.append(
      makeAuditRecord({
        orgId,
        actor: { type: "agent", id: `agent:${agentId}` },
        action: decision.status === "exceeded" ? "budget.exceeded" : "model.usage",
        resource: { type: "agent", id: `agent:${agentId}` },
        costUsd: cost,
        metadata: { status: decision.status, model }
      })
    );
    return decision;
  }

  /* ---------------- Eval gating (FR-8.2/8.3) ---------------- */

  async runEvalGate(orgId: string, input: EvalInput, policy: EvalPolicy): Promise<SuiteResult> {
    const result = await runSuite(input, {
      evals: policy.evals,
      thresholds: policy.thresholds,
      gate: policy.gate,
      evaluators: this.evaluators
    });
    this.audit.append(
      makeAuditRecord({
        orgId,
        actor: { type: "service", id: "service:eval-service" },
        action: "eval.run",
        resource: { type: "eval", id: policy.evals.join(",") || "none" },
        decision: result.passed ? "allow" : "deny",
        metadata: { failures: result.failures, blocked: result.blocked }
      })
    );
    return result;
  }
}
