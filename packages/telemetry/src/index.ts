import { AuditRecord, newId } from "@companyos/schemas";

/**
 * Telemetry: structured logging, append-only audit, and cost/budget metering
 * (docs/04-mcp-and-governance.md §4 & §6, NFR-6/NFR-9).
 */

/* ---------------- Logging ---------------- */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(bindings: Record<string, unknown> = {}, sink: (line: string) => void = () => {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, msg, ...bindings, ...fields, ts: new Date().toISOString() });
    sink(line);
  };
  return {
    child: (b) => createLogger({ ...bindings, ...b }, sink),
    log: emit,
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f)
  };
}

/* ---------------- Audit (append-only, immutable) ---------------- */

export interface AuditSink {
  append(record: AuditRecord): void;
  list(orgId: string): AuditRecord[];
  /** Tamper-evident integrity digest over the org's chain (FR-8.4, T07.12). */
  digest(orgId: string): string;
}

export interface AuditInput {
  orgId: string;
  actor: AuditRecord["actor"];
  action: string;
  resource: AuditRecord["resource"];
  traceId?: string;
  costUsd?: number;
  decision?: "allow" | "deny";
  metadata?: Record<string, unknown>;
}

/** Simple non-cryptographic hash (FNV-1a) — placeholder for a real digest. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class InMemoryAudit implements AuditSink {
  private records: AuditRecord[] = [];
  private chain = new Map<string, string>(); // orgId -> rolling digest

  append(record: AuditRecord): void {
    // immutable: copy in, never expose mutable refs
    const frozen = Object.freeze({ ...record });
    this.records.push(frozen);
    const prev = this.chain.get(record.orgId) ?? "0";
    this.chain.set(record.orgId, fnv1a(prev + JSON.stringify(frozen)));
  }

  list(orgId: string): AuditRecord[] {
    return this.records.filter((r) => r.orgId === orgId).map((r) => ({ ...r }));
  }

  digest(orgId: string): string {
    return this.chain.get(orgId) ?? "0";
  }
}

export function makeAuditRecord(input: AuditInput): AuditRecord {
  return AuditRecord.parse({
    id: newId("aud"),
    orgId: input.orgId,
    ts: new Date().toISOString(),
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    traceId: input.traceId ?? newId("trace"),
    costUsd: input.costUsd,
    decision: input.decision,
    metadata: input.metadata ?? {}
  });
}

/* ---------------- Cost metering & budgets (NFR-9) ---------------- */

export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

/** Illustrative price table; production loads from config. */
export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
  "claude-sonnet-4-6": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-haiku-4-5": { inputPerMTokUsd: 0.8, outputPerMTokUsd: 4 },
  default: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 }
};

export function meterCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? PRICES.default!;
  return (inputTokens * p.inputPerMTokUsd + outputTokens * p.outputPerMTokUsd) / 1_000_000;
}

export type BudgetStatus = "ok" | "warn" | "exceeded";

export interface BudgetDecision {
  status: BudgetStatus;
  spent: number;
  cap: number;
  remaining: number;
}

/** Tracks per-agent monthly spend; soft-warn at 80%, hard-stop at 100%. */
export class BudgetTracker {
  private spend = new Map<string, number>();
  constructor(private warnRatio = 0.8) {}

  spent(agentId: string): number {
    return this.spend.get(agentId) ?? 0;
  }

  /** Record spend and return the resulting status against the cap. */
  record(agentId: string, cap: number, costUsd: number): BudgetDecision {
    const next = this.spent(agentId) + costUsd;
    this.spend.set(agentId, next);
    return this.evaluate(agentId, cap);
  }

  /** Check whether a prospective cost would be allowed (without recording). */
  preCheck(agentId: string, cap: number, prospectiveUsd: number): BudgetDecision {
    const projected = this.spent(agentId) + prospectiveUsd;
    return this.statusFor(projected, cap, this.spent(agentId));
  }

  evaluate(agentId: string, cap: number): BudgetDecision {
    return this.statusFor(this.spent(agentId), cap, this.spent(agentId));
  }

  private statusFor(projected: number, cap: number, spent: number): BudgetDecision {
    let status: BudgetStatus = "ok";
    if (cap > 0) {
      if (projected >= cap) status = "exceeded";
      else if (projected >= cap * this.warnRatio) status = "warn";
    }
    return { status, spent, cap, remaining: Math.max(0, cap - spent) };
  }
}
