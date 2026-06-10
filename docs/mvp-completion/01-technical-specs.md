# MVP Completion — Technical Specs

**Status:** Proposed · **Date:** 2026-06-10
**Companion docs:** [`00-plan-and-model-strategy.md`](./00-plan-and-model-strategy.md) · [`../../tasks/mvp-backlog.md`](../../tasks/mvp-backlog.md)

Detailed specs per workstream: what to build, the interfaces/seams to fill,
data flow, the runtime Claude-model choices, and acceptance criteria. Specs
reference the existing code so the build stays inside established seams.

---

## W0 — Server runtime & trust boundary

**Problem:** `apps/web/src/app/lib/platform.ts` instantiates every service in the
browser; the BFF (`apps/web/src/index.ts`) exposes only `palette`/`compile`.
There is no server of record and no trust boundary.

**Decision (ADR-0008, T0.1 — Fable):** ship a **modular monolith** service
`apps/core` for the MVP. It imports the existing packages (`@companyos/brain`,
`/governance`, `/agent-registry`, `/skill-registry`, `/workflow-engine`,
`/gateway`, `/auth`, `/telemetry`, `/connectors`) and exposes:

- an **HTTP/JSON API** (Fastify) for the web client, and
- the **MCP server** (W5) for external agents,

with **all authorization and audit enforced server-side**. The nine `apps/*`
stay as libraries (already are); the K8s manifests' nine Deployments collapse to
`core` + `web` for the MVP, with the split deferred (the monolith keeps service
boundaries at the module level so a later split is mechanical). Rationale for
monolith-first: one deploy unit, one transaction boundary for the durable engine,
fastest path to the e2e thread; ADR records the split criteria for later.

**API surface (T0.2 — Opus, OpenAPI):** replace each `platform.ts` method with a
typed endpoint. Minimum set:

| Area | Endpoints |
| --- | --- |
| Auth/session | `GET /api/me`, OIDC callback (W2) |
| Brain | `POST /api/brain/search`, `GET /api/brain/item/:id` |
| Connectors | `GET /api/connectors`, `POST /api/connectors/:name/oauth/start`, `GET .../callback`, `POST .../sync` |
| Agents | `GET/POST/PATCH /api/agents`, org chart |
| Skills | `GET /api/skills`, promote |
| Workflows | `GET/POST /api/workflows`, `POST /api/builder/compile` (exists), `POST /api/workflows/:id/run`, `GET /api/runs/:id` |
| Governance | `GET /api/approvals`, `POST /api/approvals/:id/decide`, `GET /api/audit`, `GET /api/budgets` |

**Web client refactor (T0.4 — Sonnet):** `platform.ts` becomes a typed `api.ts`
HTTP client; React pages call it. Every page gets loading / error / empty states
(today everything is synchronous in-memory — see W6 trust UX).

**Acceptance:** `core` serves all of the above against the real services; web
app drives the full UI through the API with the browser holding **no**
authorization state; `docker compose up` brings up `core` + `web` + Postgres +
Keycloak + OpenFGA locally and for e2e.

---

## W1 — Persistence

**Problem:** running app uses `InMemoryAuthz/InMemoryAudit/InMemoryMemoryStore`
(`platform.ts:41`); durable SQLite adapters exist but are never instantiated;
Postgres is absent in code.

**Schema + migrations (T1.1 — Opus):** Postgres with one logical schema per
concern, `org_id` on every row, **RLS** for tenant isolation (NFR-2). Tables:
`orgs`, `users`, `agents`, `skills`, `workflows`, `workflow_versions`, `runs`,
`run_steps`, `approvals`, `memory_items` (+ `vector` column via pgvector, W3),
`memory_lineage`, `audit_log` (append-only), `budget_ledger`, `connector_tokens`
(secret refs only), `oauth_state`.

**Durable adapters (T1.2 — Sonnet):** implement Postgres-backed `AuthzEngine`
(reuse `AbstractAuthz`/`runCheck` like `SqliteAuthz`), `AuditSink` (append-only,
preserve the rolling tamper-evident digest), and the registries behind their
existing interfaces. The audit digest chain must verify across restart
(`apps/governance/src/durable.test.ts` is the model).

**Durable workflow runs (T1.3 — Fable):** persist run state so a run started,
paused at an approval, and resumed after a process restart completes correctly,
exactly once. Requirements: idempotency key per external-effect step; dedupe so a
replayed step does not double-send Slack/Jira; `runs`/`run_steps` capture
per-node input/output/cost/timing for the inspector (FR-6.7) and survive crash.
This is the in-memory engine's pause/resume (`apps/workflow-engine`) made
durable — keep the logic, move state to Postgres.

**Acceptance:** kill `core` mid-run (paused at approval), restart, approve →
the run resumes and completes with no duplicate effects; all memory/agents/
audit survive restart; cross-tenant RLS test passes.

---

## W2 — Identity & multi-tenancy

**Problem:** user hardcoded (`platform.ts:57`), no login, authz runs in the
browser, single org `"acme"`.

**OIDC login (T2.1 — Opus):** Keycloak realm (IaC exists at
`infra/platform/keycloak`) with auth-code + PKCE in the web app; `core` validates
the token, builds the `Principal` from claims via the existing
`principalFromClaims`, and establishes a server session. No principal is ever
trusted from the client.

**Server-side authz (T2.2 — Opus):** swap `InMemoryAuthz` → `OpenFgaAuthz`
(`@companyos/auth/openfga`, already CI-verified) in `core`; every API and MCP
call runs the existing `governance.authorize(...)` check + audit. **Delete
browser-side authorization as a boundary.**

**Tenancy (T2.3 — Sonnet):** org lifecycle — create org, invite users, map
Keycloak groups → roles → OpenFGA tuples; seed the demo org through this path
instead of the hardcoded `seed()`. One real tenant is the MVP bar; self-serve
multi-tenant is deferred.

**Secrets (T2.4 — Haiku):** sealed-secret wiring for Keycloak/OpenFGA/DB creds
in `infra/overlays/*` (templates exist).

**Acceptance:** a real user logs in via Keycloak; a restricted Notion page is
hidden from an unauthorized user and visible (with provenance) to an authorized
one — enforced server-side (the FR-3.5 BDD scenario, now against real auth).

---

## W3 — AI: agents, embeddings, judges

**Problem:** `extract_meeting` returns hardcoded JSON (`platform.ts:79`); search
is bag-of-words (`apps/brain/src/index.ts:128`); judges are heuristics
(`apps/eval-service/src/index.ts`). No model is ever called.

### Runtime model choices (grounded in the Claude model catalog)

- **Extraction agent:** `claude-opus-4-8` by default (intelligence-sensitive;
  the memory quality *is* the product). Configurable per agent via the existing
  `modelProvider`/`model` field; budget-metered from real usage.
- **LLM judge (factuality/hallucination):** `claude-sonnet-4-6` (runs on every
  gated output; speed/cost balance).
- **Cheap pre-filter:** `claude-haiku-4-5`.
- All calls use the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), **adaptive
  thinking** (`thinking: {type: "adaptive"}`), **structured outputs**
  (`output_config: {format: {type: "json_schema", schema: …}}`) for extraction,
  and stream when `max_tokens` is large. Provider-agnostic behind the seam.

### Real agent provider (T3.1 — Opus)

Implement `AgentHandler` (`apps/workflow-engine/src/index.ts:16`) over a real
provider client behind an `AgentProvider` interface (keep ADR-0002's seam).
Return real `{ output, model, inputTokens, outputTokens }` from the SDK's
`usage`; the existing `governance.chargeModelUsage` already meters and hard-stops
on budget. Add retries (SDK handles 429/5xx), timeouts, and a per-run token cap.

### Flagship extraction prompt + schema (T3.2 — Sonnet)

`extract_meeting` calls Claude with: the cleaned transcript + retrieved brain
context (for grounding); a JSON schema producing `decisions[]`, `risks[]`,
`customerFacts[]`, `actionItems[]`, `customerSensitive`, `confidence`, and
**citations** referencing the brain context that grounds each claim (feeds
`source_coverage`). System prompt instructs grounded, citation-backed extraction;
no ungrounded claims.

### Real embeddings + pgvector (T3.3 — Opus)

Implement a `MemoryStore` (`apps/brain/src/index.ts`) backed by pgvector: embed
title+content on ingest via an embeddings model behind an `Embedder` seam; store
the vector; retrieval keeps the existing **hybrid** scoring (vector + keyword +
recency) and the **permission filter** (OpenFGA ∩ source ACL) unchanged. Backfill
embeddings for existing items. Bag-of-words remains the offline test default.

### LLM judge (T3.4 — Sonnet)

Implement `factuality` and `hallucination_risk` `Evaluator`s
(`apps/eval-service/src/index.ts`) over a budgeted LLM judge (`claude-sonnet-4-6`)
behind the same `Evaluator` interface; keep deterministic `source_coverage` and
`policy` as cheap pre-filters that can short-circuit before a judge call. The
gating machinery (`governance.runEvalGate`) is unchanged.

**Acceptance:** a real transcript yields real, cited extraction whose claims pass
`source_coverage` against actual brain context; budget meter reflects real
tokens and hard-stops when exceeded; brain search returns semantically relevant
results over real data (a "single sign-on" query matches an "SSO" doc — which
bag-of-words cannot).

---

## W4 — Connectors & ingestion

**Problem:** only `ZoomConnector` exists and it just reshapes a payload handed to
it (`apps/connectors/src/index.ts:56`); the other 7 are UI booleans; outbound
Jira/Slack push to in-memory arrays (`platform.ts:99`); ingestion is 3 seeded
docs.

### Connector SDK v2 + source-ACL mapping (T4.1 — Fable)

Extend the connector contract (`apps/connectors/src/index.ts:35`) with:

- **OAuth** (auth-code) per connector; tokens stored as secret refs in
  `connector_tokens` (W1), never in logs; refresh handling.
- **Backfill + incremental sync** (webhook or poll) with idempotent ingest
  (existing `brain.ingest` is already idempotent on `(connector, externalId)`).
- **Faithful source-ACL mapping**: a per-connector mapping from the source's
  native permissions to the `SourceAcl` model so permission-aware retrieval is
  correct. This is the Fable-tier core — a generic, auditable mapping framework
  plus a **conformance test** every connector must pass (ACL captured correctly,
  idempotent sync, health reported, trigger emitted). Mirrors the existing
  conformance-kit idea in `docs/phases/PHASE-06`.

### Notion connector (T4.2 — Sonnet) — the MVP's first real source

Read-only OAuth; backfill pages/databases; incremental via Notion's
`last_edited_time`/webhooks; map Notion's share/permission model to `SourceAcl`;
ingest with provenance. (Drive, T4.3, is the alternative/second.)

### Zoom connector, real (T4.4 — Sonnet)

Real Zoom API + webhook: on `recording.transcript_completed`, fetch the
transcript, ingest with real provenance, and emit the `zoom_transcript` trigger
that fires the flagship workflow.

### Outbound effects (T4.5 Slack — Sonnet; T4.6 Jira — Sonnet)

Replace the in-memory `notifiers.slack`/`tasks.create_tickets` with real Slack
`chat.postMessage` and Jira `createIssue` clients, **behind the existing approval
gate** and idempotency keys (W1) so a replay does not double-send. Slack is the
MVP-required outbound; Jira is fast-follow.

### Ingestion pipeline (T4.9 — Sonnet)

Queue + worker: `fetch → extract → chunk → embed (W3) → upsert (pgvector) →
capture lineage`. Idempotent with dedupe keys; backfill progress surfaced to the
UI.

### Connectors UI, honest (T4.7 — Sonnet)

Real OAuth "Connect" flow (not a boolean toggle); states: `Not connected` /
`Connecting` / `Backfilling (n%)` / `Connected · synced Xm ago` / `Error`;
demo-data sources clearly labeled "Demo". First-run empty state.

**Acceptance:** connecting real Notion ingests real docs with correct ACLs (the
restricted-doc BDD passes against real data); a real Zoom transcript triggers the
workflow; after approval a **real** Slack message is posted exactly once.

---

## W5 — MCP server (the wedge)

**Problem:** `McpGateway` is in-process TypeScript; `@modelcontextprotocol/sdk`
is not a dependency; no external agent can connect.

### Real MCP transport + trust boundary (T5.1 — Fable)

Wrap the existing `McpGateway` (`apps/gateway/src/index.ts`) in a real MCP server
using `@modelcontextprotocol/sdk` over a network transport (Streamable HTTP).
**Auth boundary:** OIDC client credentials → `Principal` → the gateway's existing
per-call `authz.check` + audit + the policy-filtered tool catalog
(`listTools`/`callTool` are already correct — this task adds the transport and
the external auth, not new policy). Apply rate limits and budgets (FR-7.4).

### Tool catalog parity + contracts (T5.2 — Sonnet)

Expose `brain.search`, `brain.write`, `skill.run`, `workflow.trigger`, and
connector tools over MCP; Pact/contract tests for each tool boundary.

### External-client interop (T5.3 — Sonnet, e2e)

A real Claude/MCP client connects, lists only the tools its principal may call,
searches the brain, and triggers the flagship workflow — all governed and
audited.

**Acceptance:** an external MCP client retrieves the new memory created by the
flagship run, under the same authz/audit as internal callers; an unauthorized
principal sees a filtered catalog and is denied on a forbidden tool.

---

## W6 — Flagship e2e, observability, security, trust UX

### Flagship e2e (T6.1 — Opus, Playwright)

Rewrite `e2e/zoom-to-brain.spec.ts` to drive the **deployed stack** (not
in-process): login → connect Notion → ingest → transcript → real LLM extract →
eval + approval gate → durable write → Slack → MCP retrieval → audit; assert the
**negative path** (eval fail ⇒ blocked ⇒ no external effects). Emit artifacts
(screenshots, trace, run-inspector export, audit + integrity digest) to
`e2e/artifacts/`.

### Observability (T6.2 — Sonnet)

OpenTelemetry traces/metrics/logs across `core`; every run/MCP call/webhook
carries a trace id stored on the run + audit record (NFR-6).

### Security pass (T6.4 — Opus)

`/security-review` on auth/governance/gateway/secrets/IaC; verify authz on every
path, no secrets in logs, network policies default-deny, and implement data
export/delete per org + PII tagging (NFR-7).

### Trust UX (T6.3 — Sonnet)

Honest demo-vs-live labeling; first-run/empty states; async progress for
ingestion + runs; exportable audit log; provenance/timestamps front-and-center in
search results.

### Cost/observability dashboard (T6.6 — Sonnet)

Wire FR-8.5 to real spend/eval-score/latency data.

**Acceptance:** the flagship e2e passes green in CI against a deployed dev stack
with artifacts; security review clean; DoD in `00 §7` fully checked.

---

## Cross-cutting acceptance (evidence contract)

Every task ships the evidence bundle from `docs/05 §5` (red→green, BDD per FR,
e2e per journey, contract for service/MCP boundaries, coverage ≥ gate, security
scan on auth/secrets/IaC) and adds a `tasks/traceability-matrix.md` row.
