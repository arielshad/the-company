/**
 * Typed client for the `core` HTTP API (T0.4). The web app holds NO platform
 * state or authorization — it is a thin client over the server of record. In
 * dev, `core` resolves the principal from `x-dev-principal` (defaulting to the
 * demo admin), so no login is needed locally; in prod an OIDC bearer is attached.
 */

export interface Me { id: string; type: string; orgId: string; roles: string[]; groups: string[] }
export type ConnectorKind = "source" | "outbound" | "webhook";
export interface Connector {
  name: string;
  label: string;
  category: string;
  kind: ConnectorKind;
  configured: boolean;
  connected: boolean;
  demo: boolean;
  lastSyncAt?: string;
}
export interface SearchHit { id: string; title: string; snippet: string; score: number; type: string; source: { connector: string; externalId: string; url?: string } }
export interface GraphEntity { id: string; name: string; type: string; firstSeen: string; lastSeen: string }
export interface GraphEdge { id: string; subjectId: string; predicate: string; object: string; validFrom: string; validTo?: string; confidence: number }
export interface Agent { id: string; name: string; role: string; goal?: string; status: string; managerAgentId?: string; budgetMonthlyUsd: number; model?: string }
export interface Skill { id: string; name: string; status: "draft" | "active" | "deprecated"; description?: string; owner: string; source: string; allowedRoles: string[]; requiredTools: string[]; version: number; changelog: string[] }
export interface Approval { id: string; orgId: string; runId: string; nodeId: string; status: string; payload?: unknown; createdAt: number }
export interface AuditRecord { id: string; orgId: string; action: string; decision: string; actor: { type: string; id: string }; resource?: { type: string; id: string }; ts: string; costUsd?: number }
export interface Budget { agentId: string; name: string; spentUsd: number; cap?: number }
export interface Workflow { id: string; name: string; version?: number; state?: string; nodes?: unknown[]; edges?: unknown[]; trigger?: unknown }
export interface RunRecord { id: string; orgId: string; workflowId: string; status: string; startedAt?: string; log?: unknown[]; awaiting?: unknown }

const BASE: string =
  (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL) ||
  "http://localhost:8080";

/** Optional dev principal override (e.g. to act in another org). */
let devPrincipal: Record<string, unknown> | null = null;
export function setDevPrincipal(p: Record<string, unknown> | null) {
  devPrincipal = p;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (devPrincipal) headers["x-dev-principal"] = JSON.stringify(devPrincipal);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  base: BASE,
  me: () => req<Me>("GET", "/api/me"),

  // brain + graph
  search: (query: string, topK?: number) => req<{ hits: SearchHit[] }>("POST", "/api/brain/search", { query, topK }).then((r) => r.hits),
  graphEntities: () => req<{ entities: GraphEntity[] }>("GET", "/api/brain/graph/entities").then((r) => r.entities),
  graphNeighbors: (entity: string, asOf?: string) =>
    req<{ edges: GraphEdge[] }>("GET", `/api/brain/graph/neighbors?entity=${encodeURIComponent(entity)}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ""}`).then((r) => r.edges),

  // connectors / integrations
  connectors: () => req<{ connectors: Connector[] }>("GET", "/api/connectors").then((r) => r.connectors),
  authorizeUrl: (name: string) => req<{ authorizeUrl: string }>("GET", `/api/connectors/${name}/authorize-url`).then((r) => r.authorizeUrl),
  connectToken: (name: string, accessToken: string) => req<{ connected: boolean }>("POST", `/api/connectors/${name}/connect`, { accessToken }),
  oauthExchange: (name: string, code: string, redirectUri: string) => req<{ connected: boolean }>("POST", `/api/connectors/${name}/oauth`, { code, redirectUri }),
  disconnect: (name: string) => req<{ connected: boolean }>("POST", `/api/connectors/${name}/disconnect`),
  backfill: (name: string, since?: string) => req<{ ingested: number; deduped: number }>("POST", `/api/connectors/${name}/backfill`, { since }),
  webhook: (name: string, payload: unknown) => req<{ itemId: string; deduped: boolean; runId?: string; status?: string }>("POST", `/api/connectors/${name}/webhook`, payload),

  // agents
  agents: () => req<{ agents: Agent[] }>("GET", "/api/agents").then((r) => r.agents),
  orgChart: () => req<{ orgChart: unknown }>("GET", "/api/agents/org-chart").then((r) => r.orgChart),
  createAgent: (a: { name: string; role?: string; goal?: string; managerAgentId?: string }) => req<{ agent: Agent }>("POST", "/api/agents", a).then((r) => r.agent),

  // skills
  skills: (role?: string) => req<{ skills: Skill[] }>("GET", `/api/skills${role ? `?role=${encodeURIComponent(role)}` : ""}`).then((r) => r.skills),

  // workflows / runs
  workflows: () => req<{ workflows: Workflow[] }>("GET", "/api/workflows").then((r) => r.workflows),
  workflow: (id: string) => req<{ workflow: Workflow }>("GET", `/api/workflows/${id}`).then((r) => r.workflow),
  runWorkflow: (id: string, data?: Record<string, unknown>) => req<unknown>("POST", `/api/workflows/${id}/run`, { data }),
  runs: () => req<{ runs: RunRecord[] }>("GET", "/api/runs").then((r) => r.runs),
  run: (id: string) => req<{ run: RunRecord }>("GET", `/api/runs/${id}`).then((r) => r.run),

  // governance
  approvals: () => req<{ approvals: Approval[] }>("GET", "/api/approvals").then((r) => r.approvals),
  decideApproval: (id: string, decision: "approved" | "rejected", rationale?: string) =>
    req<{ approval: Approval }>("POST", `/api/approvals/${id}/decide`, { decision, rationale }).then((r) => r.approval),
  audit: () => req<{ audit: AuditRecord[]; digest: string }>("GET", "/api/audit"),
  budgets: () => req<{ budgets: Budget[] }>("GET", "/api/budgets").then((r) => r.budgets),

  // org / tenancy
  createOrg: (orgId: string) => req<{ orgId: string }>("POST", "/api/orgs", { orgId })
};

export type Api = typeof api;
