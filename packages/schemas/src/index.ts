import { z } from "zod";

/**
 * Canonical CompanyOS data models (docs/03-data-models.md).
 * Zod is the runtime source of truth; types are inferred from schemas.
 */

export const Role = z.enum([
  "CEO",
  "PM",
  "Engineer",
  "Researcher",
  "Sales",
  "Support"
]);

export const ModelProvider = z.enum(["anthropic", "openai", "google", "local"]);

export const ApprovalTrigger = z.enum([
  "external_send",
  "code_change",
  "expense",
  "customer_comms",
  "low_confidence"
]);

export const ApprovalPolicy = z.object({
  triggers: z.array(ApprovalTrigger).default([]),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  approvers: z.array(z.string()).default([]),
  escalateAfterMinutes: z.number().int().positive().optional(),
  onTimeout: z.enum(["reject", "escalate", "auto_approve"]).default("escalate")
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

const base = {
  id: z.string().min(1),
  orgId: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  createdBy: z.string().optional()
};

export const Agent = z.object({
  ...base,
  name: z.string().min(1),
  role: z.union([Role, z.string().min(1)]),
  goal: z.string().default(""),
  modelProvider: ModelProvider.default("anthropic"),
  model: z.string().optional(),
  budgetMonthlyUsd: z.number().nonnegative().default(0),
  tools: z.array(z.string()).default([]),
  memoryScopes: z.array(z.string()).default([]),
  approvalPolicy: ApprovalPolicy.default({}),
  managerAgentId: z.string().optional(),
  status: z.enum(["active", "paused", "archived"]).default("active")
});
export type Agent = z.infer<typeof Agent>;

export const MemoryType = z.enum([
  "decision",
  "task",
  "meeting",
  "customer_fact",
  "project_update",
  "risk",
  "document"
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const SourceRef = z.object({
  connector: z.string().min(1),
  externalId: z.string().min(1),
  ingestionRunId: z.string().optional(),
  url: z.string().optional()
});
export type SourceRef = z.infer<typeof SourceRef>;

export const MemoryObject = z.object({
  ...base,
  type: MemoryType,
  title: z.string().min(1),
  content: z.string(),
  source: SourceRef,
  timestamp: z.string(),
  confidence: z.number().min(0).max(1),
  visibility: z.array(z.string()).default([]),
  relatedPeople: z.array(z.string()).default([]),
  relatedProjects: z.array(z.string()).default([]),
  supersedes: z.string().optional(),
  expiresAt: z.string().optional()
});
export type MemoryObject = z.infer<typeof MemoryObject>;

export const Skill = z.object({
  ...base,
  name: z.string().min(1),
  owner: z.string().min(1),
  description: z.string().default(""),
  source: z.enum(["notion", "github", "google_drive"]),
  sourceRef: z.string().min(1),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  requiredTools: z.array(z.string()).default([]),
  workflowId: z.string().optional(),
  approvalRequired: z.boolean().default(false),
  allowedRoles: z.array(z.string()).default([]),
  version: z.string().default("0.1.0"),
  status: z.enum(["draft", "active", "deprecated"]).default("draft")
});
export type Skill = z.infer<typeof Skill>;

export const PermissionPolicy = z.object({
  runAs: z.enum(["user", "agent", "service"]).default("agent"),
  requiredRelations: z.array(z.string()).default([])
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const MemoryWritePolicy = z.object({
  allowedTypes: z.array(MemoryType).default([]),
  minConfidence: z.number().min(0).max(1).default(0),
  requireApprovalBelow: z.number().min(0).max(1).optional()
});
export type MemoryWritePolicy = z.infer<typeof MemoryWritePolicy>;

export const EvalPolicy = z.object({
  evals: z.array(z.string()).default([]),
  gate: z.enum(["advisory", "block"]).default("advisory"),
  thresholds: z.record(z.number()).default({})
});
export type EvalPolicy = z.infer<typeof EvalPolicy>;

export const AuditRecord = z.object({
  id: z.string(),
  orgId: z.string(),
  ts: z.string(),
  actor: z.object({
    type: z.enum(["user", "agent", "service"]),
    id: z.string()
  }),
  action: z.string(),
  resource: z.object({ type: z.string(), id: z.string() }),
  traceId: z.string(),
  costUsd: z.number().optional(),
  decision: z.enum(["allow", "deny"]).optional(),
  metadata: z.record(z.unknown()).default({})
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** Helper: generate a stable-ish id for tests/services. */
export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
