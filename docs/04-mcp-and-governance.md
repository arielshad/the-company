# 04 — MCP Gateway & Governance

This document defines the security and governance backbone: how external and
internal agents reach company resources, and how every action is authorized,
budgeted, evaluated, and audited.

---

## 1. MCP Gateway

The gateway is a **policy-enforcing MCP server** and the single front door for
all agent access (external clients and internal services alike).

### Responsibilities
- Expose approved tools over MCP: `brain.search`, `brain.write`, `skill.run`,
  `workflow.trigger`, connector tools, and registered custom tools.
- Authenticate every client via OIDC (Keycloak) and resolve to a CompanyOS
  **principal** (user, agent, or service).
- Enforce authorization on **every** tool call via OpenFGA before execution.
- Filter the advertised tool catalog **per principal** — a client only sees
  tools it is permitted to call.
- Apply rate limits and budget checks; emit an audit record per invocation.

### Request lifecycle
```
client (Claude/Cursor/ChatGPT/Claude Code)
  → MCP connect (OIDC bearer)
  → gateway validates token → principal
  → tools/list  → policy-filtered catalog for that principal
  → tools/call  → OpenFGA check(principal, relation, object)
                  → budget & rate-limit check
                  → dispatch to owning service (brain/skill/workflow/connector)
                  → record audit (actor, action, resource, decision, cost, traceId)
                  → return result
```

### Tool catalog (initial)
| Tool | Backed by | Authz object |
| --- | --- | --- |
| `brain.search` | brain | `brain:reader` |
| `brain.write` | brain | `brain:writer` |
| `skill.run` | skill-registry → workflow-engine | `skill:<id>#runner` |
| `workflow.trigger` | workflow-engine | `workflow:<id>#trigger` |
| `connector.<x>.*` | connectors | `connector:<x>#user` |

---

## 2. Authorization model (OpenFGA / ReBAC)

A single authorization model, versioned in `infra/platform/openfga/model.fga`,
is the only place authz decisions are made.

### Types & relations (sketch)
```
type org
  relations
    define member: [user, agent]
    define admin: [user]
    define owner: [user]

type team
  relations
    define parent: [org]
    define lead: [user]
    define member: [user, agent] or member from parent

type brain
  relations
    define parent: [org]
    define reader: [user, agent, team#member] or member from parent
    define writer: [user, agent, team#member]

type skill
  relations
    define parent: [org]
    define runner: [user, agent, team#member]
    define editor: [user, team#lead]

type workflow
  relations
    define parent: [org]
    define trigger: [user, agent, team#member]
    define editor: [user, team#lead]

type memory_object
  relations
    define parent: [brain]
    define viewer: [user, agent] or reader from parent   # + source-ACL filter
```

### Permission-aware retrieval
Brain search applies **two** filters:
1. OpenFGA relation check (can the principal read this brain/scope?).
2. **Source ACL filter** — ingested objects carry their origin permissions
   (e.g. a Notion page restricted to a group); retrieval intersects with the
   principal's identity so agents never surface documents the requesting human
   could not see.

---

## 3. Approvals (human-in-the-loop)

- An `approval` node (or an action matching an `ApprovalPolicy` trigger) pauses
  the run, creates an **approval request**, and notifies approvers.
- Approval requests are durable; the run resumes on decision or follows
  `onTimeout` (`reject | escalate | auto_approve`).
- Triggers: `external_send`, `code_change`, `expense`, `customer_comms`,
  `low_confidence` (below threshold).
- Every decision is audited with approver identity, timestamp, and rationale.

---

## 4. Budgets & cost control

- Each agent has `budgetMonthlyUsd`. Every model call is metered by a
  budget-aware provider client (tokens × price → USD).
- Soft warning at 80%, hard stop at 100% (configurable); a `budget.exceeded`
  audit event is emitted and the run is paused/failed per policy.
- Spend is rolled up per agent / workflow / skill / org for the dashboard.

---

## 5. Evals

- Eval kinds: `quality`, `factuality`, `policy`, `tone`, `source_coverage`,
  `hallucination_risk`.
- Defined per skill (`evals.yaml`) and per workflow (`evalPolicy`).
- **Gating:** `gate: block` prevents external-effect nodes from running when an
  eval fails its threshold; `advisory` records the score without blocking.
- Skills cannot be promoted `draft → active` unless their eval suite passes
  (CI gate, see `07-quality-gates.md`).
- Eval runners live in `eval-service`; LLM-judge calls are themselves budgeted
  and audited.

---

## 6. Audit & lineage

- **Audit log** is append-only and immutable (no update/delete API; retention &
  legal hold per org). Every tool call, memory write, approval, and budget event
  produces an `AuditRecord` (see `03-data-models.md`).
- **Data lineage:** every memory object references its `SourceRef`
  (connector + external id + ingestion run), so any answer can be traced to its
  origin document and the run that ingested it.
- Audit is **separate** from operational logs (Loki) and traces (Tempo); audit
  is a compliance artifact, not a debug stream.

---

## 7. Threat model (summary)

| Threat | Mitigation |
| --- | --- |
| Token theft / replay | Short-lived OIDC tokens, audience binding, mTLS in-mesh |
| Over-broad agent access | OpenFGA least-privilege; per-principal tool catalog; per-agent tool allowlist |
| Data exfiltration via search | Source-ACL filter + OpenFGA on every retrieval; egress NetworkPolicies |
| Prompt injection from ingested content | Treat ingested/external content as untrusted; tool calls still authz-checked; approval gates on external effects; eval `policy` check |
| Secret leakage | Sealed Secrets only in git; no secrets in logs; secret scanning in CI |
| Budget abuse / runaway loops | Per-agent budgets, loop bounds, rate limits, hard stops |
| Cross-tenant leakage | `org_id` on every row + Postgres RLS + per-org vector namespaces + namespaced OpenFGA objects |
| Tampering with audit | Append-only store, write-once, periodic integrity digest |

> **Prompt-injection stance:** content ingested from connectors or returned by
> tools is **untrusted data**, never instructions. Agents may summarize it, but
> any *action* (tool call, external send, memory write) is independently
> authorized and, where policy requires, gated by approval and evals.

---

## 8. Keycloak (identity)

- Realm-as-code in `infra/platform/keycloak/realm-companyos.json`.
- Clients: `companyos-web` (public/PKCE), `companyos-gateway` (confidential),
  per-service confidential clients for service-to-service tokens.
- Roles map to CompanyOS roles (`owner/admin/builder/member/auditor/agent`) and
  are mirrored into OpenFGA relations on login/sync.
- Connector OAuth credentials are **not** in Keycloak; they are per-connector
  sealed secrets with least-privilege provider scopes.
