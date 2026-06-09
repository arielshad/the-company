# 01 — Product Specification

This is the full functional specification. Requirements are tagged `FR-x.y`
(functional) and `NFR-x` (non-functional) so they can be traced to tasks and
tests in `tasks/traceability-matrix.md`.

---

## 1. Personas

| Persona | Description | Primary needs |
| --- | --- | --- |
| **Admin / IT** | Owns the CompanyOS instance | SSO, permissions, budgets, audit, connectors |
| **Ops / Workflow builder** | Builds workflows & skills (low-code) | Visual builder, templates, approvals |
| **Department lead** | Owns agents for a team (Sales, Eng…) | Agent roles, goals, budgets, reporting |
| **End user / employee** | Consumes the brain & runs tasks | Search, ask, run skills, see results |
| **External agent** | Claude / Cursor / ChatGPT / Claude Code | MCP access to brain + approved tools |
| **Auditor / Compliance** | Reviews actions | Immutable audit log, eval reports, data lineage |

---

## 2. Capabilities (epics)

### E1 — Identity, tenancy & access
- **FR-1.1** SSO via Keycloak (OIDC); users, groups, roles synced into CompanyOS.
- **FR-1.2** Multi-tenant by **organization**; hard isolation of data and secrets per org.
- **FR-1.3** Role model: `owner`, `admin`, `builder`, `member`, `auditor`, `agent`.
- **FR-1.4** Fine-grained authorization via OpenFGA (relationship-based: org → team → resource).
- **FR-1.5** Service-to-service auth via OIDC client credentials / mTLS in-mesh.

### E2 — Connectors & ingestion
- **FR-2.1** Connectors: Notion, Google Drive, GitHub, Slack, Gmail, Google Calendar, Zoom, Jira.
- **FR-2.2** Each connector supports **initial backfill** + **incremental sync** (webhook or poll).
- **FR-2.3** Per-connector OAuth with least-privilege scopes; tokens stored as sealed secrets / vault refs.
- **FR-2.4** Connector health, last-sync, error surfacing in admin UI.
- **FR-2.5** Source-level ACL capture: ingested objects carry their origin permissions for permission-aware retrieval.

### E3 — Company Brain (memory & search)
- **FR-3.1** Ingestion pipeline: extract → chunk → embed → index (pgvector primary, Qdrant optional at scale).
- **FR-3.2** Hybrid retrieval: vector + keyword (BM25) + recency + permission filter.
- **FR-3.3** **Temporal memory graph** (Graphiti-style): entities (people, projects, customers, decisions) with valid-time edges.
- **FR-3.4** Typed memory objects: `decision | task | meeting | customer_fact | project_update | risk | document` (see `03-data-models.md`).
- **FR-3.5** Permission-aware search: a user/agent only retrieves what their OpenFGA relations + source ACLs allow.
- **FR-3.6** Memory write API with provenance (`source`, `confidence`, `timestamp`, `visibility`).
- **FR-3.7** Memory lifecycle: supersede/merge, `expiresAt`, soft-delete with audit.
- **FR-3.8** `brain.search` and `brain.write` exposed as MCP tools (subject to E7 governance).

### E4 — Agent registry (manage agents like employees)
- **FR-4.1** CRUD agents with: `role`, `goal`, `modelProvider`, `budgetMonthlyUsd`, `tools`, `memoryScopes`, `approvalPolicy`, `managerAgentId`.
- **FR-4.2** Org chart / reporting lines (supervisor → reports), visualized.
- **FR-4.3** Budget enforcement: per-agent monthly USD cap; soft-warn + hard-stop; spend metered per run.
- **FR-4.4** Agent templates (CEO, PM, Engineer, Researcher, Sales, Support).
- **FR-4.5** Run a manual task against an agent; capture output + cost + tool calls.
- **FR-4.6** Per-agent activity feed, evaluation scores, and audit linkage.

### E5 — Skill registry
- **FR-5.1** Skill = portable, versioned package: `SKILL.md`, `workflow.yaml`, `tools.json`, `examples.md`, `evals.yaml`.
- **FR-5.2** Sources: Notion (MVP) → GitHub-backed packages (versioned) → Google Drive (optional).
- **FR-5.3** Skill metadata: `owner`, `inputSchema`, `outputSchema`, `requiredTools`, `approvalRequired`, `allowedRoles`, `version`, `status`.
- **FR-5.4** Sync engine: pull from source → validate schema → register/version → diff & changelog.
- **FR-5.5** Department namespaces: `sales/`, `engineering/`, `support/`, `product/`, `finance/`, `hr/`, `founder/`.
- **FR-5.6** Skills runnable directly or referenced as nodes inside workflows.
- **FR-5.7** Each skill ships `evals.yaml`; skills cannot be promoted to `active` without passing evals (see E8).

### E6 — Workflow builder & engine
- **FR-6.1** Visual builder (React Flow): drag-and-drop canvas, node config panels, live validation.
- **FR-6.2** Node types: `Trigger`, `Brain Search`, `Agent`, `Tool/MCP Tool`, `Skill`, `Condition`, `Loop`, `Approval`, `Memory Write`, `Task`, `Eval`, `Notify`, `End`.
- **FR-6.3** Triggers: manual, schedule, webhook, email, calendar, Zoom transcript, Slack event, GitHub PR, Jira issue.
- **FR-6.4** Canvas compiles to a versioned **Workflow DSL** (declarative, see `03-data-models.md`).
- **FR-6.5** Durable execution: long-running, resumable, retryable; survives restarts (Trigger.dev → Temporal at scale).
- **FR-6.6** Human-in-the-loop: `Approval` node pauses run, notifies approver, resumes on decision; full audit.
- **FR-6.7** Run inspector: per-node inputs/outputs, timing, cost, logs, replay.
- **FR-6.8** Workflow versioning, draft vs. published, rollback.
- **FR-6.9** Per-workflow `permissions`, `memoryWritePolicy`, `evalPolicy`.

### E7 — MCP gateway (external & internal access)
- **FR-7.1** Single MCP endpoint exposing approved tools: `brain.search`, `brain.write`, `skill.run`, `workflow.trigger`, connector tools, custom tools.
- **FR-7.2** Per-client auth (OIDC) → maps to a CompanyOS principal → OpenFGA checks on every tool call.
- **FR-7.3** Tool catalog is **policy-filtered per principal** (a client only sees tools it may call).
- **FR-7.4** Rate limits, budgets, and audit applied to every MCP invocation.
- **FR-7.5** Compatible with Claude, Claude Code, Cursor, ChatGPT, and custom MCP clients.

### E8 — Governance, approvals, evals & audit
- **FR-8.1** Approval policies: when (external send, code change, expense, customer comms, low confidence), who, escalation, timeout.
- **FR-8.2** Eval framework: quality, factuality, policy/tone, source coverage, hallucination risk; pass/fail thresholds.
- **FR-8.3** Evals gate skill promotion and (optionally) workflow outputs before external action.
- **FR-8.4** Immutable, append-only audit log for every agent action, tool call, memory write, approval, and budget event.
- **FR-8.5** Cost/observability dashboard: spend by agent/workflow/skill, success rates, eval scores, latency.
- **FR-8.6** Data lineage: any memory object traces back to its source object + ingestion run.

### E9 — Notifications & tasking
- **FR-9.1** Notify channels: Slack, email, Jira, Linear, Notion.
- **FR-9.2** Task actions: create ticket, assign owner, schedule follow-up, update CRM, write doc.

---

## 3. Non-functional requirements

- **NFR-1 Security:** OIDC SSO, OpenFGA authz on every call, secrets sealed/at-rest encrypted, mTLS in-mesh, least-privilege connector scopes, no secrets in logs. Threat model in `04-mcp-and-governance.md`.
- **NFR-2 Tenancy isolation:** per-org logical isolation in Postgres (row-level + schema), per-org vector namespaces, per-org secrets.
- **NFR-3 Reliability:** workflow runs are durable & idempotent; at-least-once with dedupe keys; RPO ≤ 5 min, RTO ≤ 30 min.
- **NFR-4 Performance:** brain search p95 < 800 ms at 1M chunks/org; builder canvas interactions < 100 ms.
- **NFR-5 Scalability:** horizontal scale of stateless services; connectors and workflow workers scale independently.
- **NFR-6 Observability:** OpenTelemetry traces/metrics/logs; every run carries a trace id; audit ≠ logs.
- **NFR-7 Compliance:** audit immutability, data export & delete per org (GDPR-style), PII tagging.
- **NFR-8 Portability:** runs on any CNCF-conformant K8s; no hard cloud lock-in; object storage via S3 API.
- **NFR-9 Cost control:** model spend metered & capped per agent/org; provider-agnostic routing.
- **NFR-10 Accessibility:** builder & dashboards WCAG 2.1 AA.

---

## 4. MVP scope (what ships first, in order)

Per the phased plan (`docs/phases/`), the MVP is delivered as four product
increments on top of a platform foundation:

- **MVP-0 Foundation** — monorepo, CI, K8s app-of-apps, Keycloak SSO, OpenFGA, Postgres, observability. (PHASE-00)
- **MVP-1 Agent registry** — create agents, roles, tools, budgets, manager; run manual task; track output. (PHASE-01)
- **MVP-2 Brain** — connect Notion + Drive + GitHub; search; write memory from meetings/docs; `brain.search` via MCP. (PHASE-02)
- **MVP-3 Builder** — React Flow builder with `Trigger, Brain Search, Agent, MCP Tool, Condition, Approval, Memory Write, Notify`; durable execution. (PHASE-03 + PHASE-04 engine)
- **MVP-4 Skill registry** — Notion-as-source skills synced into backend; run skills; evals gate. (PHASE-05)

Hardening, additional connectors, Temporal migration, and Graphiti depth follow
in PHASE-06 … PHASE-08.

---

## 5. Out of scope (v1)

- On-prem air-gapped install (cloud K8s first).
- Fine-tuning / training models (we route to providers).
- Mobile native apps (responsive web only).
- Marketplace billing for third-party skills.

## 6. Example end-to-end scenario (acceptance reference)

**"Zoom meeting transcript → company brain"** — used as the flagship e2e
acceptance test (see `docs/phases/PHASE-04` and `05-development-methodology.md`):

```
Trigger: Zoom transcript received
 1. Clean transcript
 2. Agent extracts: summary, decisions, action items, risks, customer facts, project updates
 3. Search existing memory for related project/customer
 4. Decide: update existing memory vs. create new
 5. Approval if customer-sensitive OR confidence < 0.8
 6. Write to brain
 7. Create Jira/Linear tasks
 8. Notify Slack channel
 9. Expose updated context to Claude via MCP
```

This single scenario exercises connectors, brain, agents, workflow engine,
approvals, governance, tasking, notifications, and MCP — and is the proof that
the system is more than a RAG chatbot.
