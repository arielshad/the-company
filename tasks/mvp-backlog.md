# MVP Completion Backlog

The authoritative task list to finish the MVP **end-to-end** (the single value
thread in `docs/mvp-completion/00-plan-and-model-strategy.md §1`). Specs:
`docs/mvp-completion/01-technical-specs.md`. Tier rationale model:
`docs/mvp-completion/00-plan-and-model-strategy.md §4`.

> ## Scope: zero mocks — everything integrated (decision 2026-06-12)
>
> The target is now **no mock anywhere in the running flow** — every integration
> real, not gated-to-a-stub. This is **broader than the original MVP scope**,
> which deferred 7 of 8 connectors, Graphiti, Qdrant, and self-serve tenancy
> (`docs/MVP-GAP.md §7`). Those deferrals are **lifted**; the un-deferred work is
> added as workstream **W7** below. "Gated" (real adapter, stub fallback when a
> secret is absent) does **not** count as done for this target — the real path
> must be the wired default, with the stub reserved for offline CI only.
>
> **Status legend (per-task column added below):**
> ✅ **Done** real & wired · 🔌 **Gated** real adapter exists, stub fallback is
> still the default · 🟡 **Partial** code exists but not wired into the live flow
> · 🔴 **Mock** in-memory/heuristic stand-in only · ⬜ **Pending** not started.

**Tier legend:** **F** = Fable 5 (`claude-fable-5`) · **O** = Opus 4.8
(`claude-opus-4-8`) · **S** = Sonnet 4.6 (`claude-sonnet-4-6`) · **H** = Haiku
4.5 (`claude-haiku-4-5`).

Every task carries a **Tier rationale** so the orchestrator knows *why* a model
is needed — not just which. All tasks obey the evidence contract in
`docs/05-development-methodology.md` (red→green, BDD per FR, e2e per journey).

---

## Status snapshot (2026-06-12) — authoritative

Single source of truth for what is real vs. mock right now. Verified against
code + `docs/mvp-completion/HANDOFF.md §0.5`. ✅ done&wired · 🔌 gated · 🟡 partial
(code exists, not wired) · 🔴 mock · ⬜ pending.

| Task | Status | Reality today |
| --- | --- | --- |
| T0.1 core monolith + infra reconcile | ✅ | `apps/core`; infra collapsed to core/web/openfga |
| T0.2/T0.3 OpenAPI + Fastify API | ✅ | typed endpoint per `platform.ts` method, via gateway authz/audit |
| T0.4 web → typed API client | ⬜ | web still drives in-browser platform |
| T0.5/T0.6 Dockerfiles + compose + CI | ✅ | core image, compose-smoke green |
| T0.7 shep-infra apply (Argo, setup, pgvector enable) | ⬜ | glue written (PR #20); not applied → prod can't boot on PG yet |
| T1.1/T1.2 PG schema, RLS, audit chain | ✅ | verified vs real PG16+pgvector |
| T1.3 durable runs persist+resume | 🟡 | resume slice + effect idempotency done; runs still in-memory (run/run_steps not persisted) |
| T1.4 seed via real tenant path | ⬜ | — |
| T2.1 Keycloak OIDC login + token validation | 🟡 | `auth/session.ts` jose verify exists; realm not wired; dev-`alice` is default |
| T2.2 server-side OpenFGA authz every call | 🟡 | `OpenFgaAuthz` adapter exists; not enforced on every endpoint |
| T2.3 org lifecycle → OpenFGA tuples | ⬜ | single hardcoded demo org |
| T2.4 ESO ExternalSecrets | ⬜ | — |
| T3.1 real Claude `AgentHandler` | 🔌 | real Anthropic SDK with `ANTHROPIC_API_KEY`; else `mockExtract()` |
| T3.2 flagship extract prompt + schema | 🟡 | real-path tool schema exists; grounding/citations to verify |
| T3.3 real embeddings + pgvector store | 🔌 | real `Embedder` (OpenAI-compatible `/v1/embeddings`, e.g. Infinity + bge-m3) wired into brain search (gated on `EMBEDDINGS_BASE_URL`); bag-of-words is the offline fallback |
| T3.4 LLM judges | 🔌 | real Anthropic judge for factuality/hallucination behind the (now async) `Evaluator` (gated on `ANTHROPIC_API_KEY`); heuristics are the offline fallback + pre-filters |
| T3.5 eval thresholds config | ⬜ | — |
| T4.1 connector SDK v2 + conformance kit | ✅ | caps + ACL seam + conformance kit |
| T4.2 Notion connector | 🔌 | **registered** + `platform.backfillSource` ingest path wired (gated on `NOTION_*` OAuth creds); tested with injected fetch |
| T4.3 Google Drive connector | 🔌 | real connector + registered via `backfillSource` (gated on `GOOGLE_DRIVE_*`); conservative ACL, conformance-reviewed |
| T4.4 Zoom connector | ✅ | real API + HMAC webhook → ingest + trigger |
| T4.5 outbound Slack | 🔌 | real `SlackNotifier` **wired into** `effects.ts` (gated on `SLACK_BOT_TOKEN`); capture ledger retained as audit mirror |
| T4.6 outbound Jira | 🔌 | real `JiraClient` (`connectors/jira.ts`) wired into `effects.ts` (gated on `JIRA_*`), idempotent |
| T4.7 connectors UI (real OAuth + honest states) | 🟡 | data now honest (`demo` flag; no fictional green dots); UI surfacing pending |
| T4.8 per-connector OAuth scopes + secrets | ⬜ | — |
| T4.9 ingestion pipeline (queue→chunk→embed→lineage) | 🟡 | webhook→ingest plumbed; no queue/worker/chunk/embed/lineage |
| T5.1 real MCP server transport | ✅ | `@modelcontextprotocol/sdk` Streamable HTTP + OIDC boundary + rate limit |
| T5.2 MCP catalog parity + contracts | 🟡 | gateway tools exposed; Pact/contract parity pending |
| T5.3 external Claude/MCP client interop | ⬜ | — |
| T5.4 MCP ingress + netpol | ⬜ | — |
| T6.1 flagship Playwright e2e on deployed stack | ⬜ | in-memory flagship test only |
| T6.2 OpenTelemetry | ⬜ | — |
| T6.3 trust UX (demo-vs-live, empty states, export) | ⬜ | — |
| T6.4 security pass | ⬜ | — |
| T6.5 CI flagship e2e | ⬜ | core image + compose-smoke done; no e2e on PR |
| T6.6 cost/observability dashboard | ⬜ | — |
| T7.1 GitHub connector | 🔌 | real connector + registered (gated on `GITHUB_*`); ACL data-leak found in review **fixed** (restricted-wins) + regression-tested |
| T7.2 Gmail connector | 🔌 | real connector + registered (gated on `GMAIL_*`); owner-only ACL, never public |
| T7.3 Google Calendar connector | 🔌 | real connector + registered (gated on `GOOGLE_CALENDAR_*`); attendee/organizer ACL |
| T7.4 Slack read connector | ⬜ | outbound Slack is done (T4.5); read side pending |
| T7.5 Graphiti temporal memory graph | ⬜ | large/novel — own PR (entity/edge + bitemporal graph behind MemoryStore) |
| T7.6 self-serve multi-tenant org creation | ⬜ | single hardcoded demo org today |

---

## Tier summary

| Workstream | Tasks | F | O | S | H |
| --- | --- | --- | --- | --- | --- |
| W0 Server runtime & trust boundary | 7 | 1 | 2 | 3 | 1 |
| W1 Persistence | 4 | 1 | 1 | 1 | 1 |
| W2 Identity & multi-tenancy | 4 | 0 | 2 | 1 | 1 |
| W3 AI (agents, embeddings, judges) | 5 | 0 | 2 | 2 | 1 |
| W4 Connectors & ingestion | 9 | 1 | 0 | 6 | 2 |
| W5 MCP server | 4 | 1 | 0 | 2 | 1 |
| W6 E2e, observability, security, UX | 6 | 0 | 2 | 3 | 1 |
| **Total** | **39** | **4** | **9** | **18** | **8** |

≈ **10% Fable / 23% Opus / 46% Sonnet / 21% Haiku** — Fable on the 4
novel-and-catastrophic-if-wrong tasks; Opus on security/data-model/provider (incl.
the cross-repo shep-infra integration T0.7); Sonnet carries build volume; Haiku on
mechanical config/scaffolds.

---

## W0 — Server runtime & trust boundary

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T0.1** | ADR-0008 (**written**): modular-monolith `apps/core` hosting existing packages behind HTTP+MCP; trust boundary server-side; web thin client; **shep-infra platform boundary** (consume shared Postgres/Keycloak/ESO-Infisical; manifests in-repo). Remaining: architecture test + `infra/` reconcile | NFR-1,2,8 | **F** | Sets the architecture **every** other MVP task builds on; modular-monolith-vs-microservices is novel for this repo, irreversible once built on, and a wrong call forces re-wiring all of W1–W6. Clears ≥3 axes + ≥3 downstream deps. | ADR + architecture test (compose stack boots) |
| **T0.2** | Define typed HTTP API (OpenAPI) replacing every `platform.ts` method | FR-6.*,3.*,8.* | **O** | Cross-service contract design + data-shape decisions that constrain the web client and the durable engine; interface-defining, hard to reverse. | Contract (OpenAPI lint) + unit |
| **T0.3** | Implement Fastify API server in `core` wiring brain/governance/agents/skills/workflows/approvals/audit | FR-6.*,8.* | **S** | Known pattern (HTTP service over existing libs); volume build once the contract (T0.2) is fixed. | Integration (API ↔ services) |
| **T0.4** | Refactor web app: `platform.ts` → typed API client; pages call API; loading/error/empty states | FR-6.1,6.7 | **S** | React feature work against a fixed contract; no novel design. | e2e (pages render against API) |
| **T0.5** | Dockerfiles for `core` + `web`; build+push to `ghcr.io/arielshad/the-company-{core,web}` in CI; image tags in `infra/overlays/<env>` | NFR-8 | **H** | Mechanical — one Dockerfile from the existing `apps/web/Dockerfile` pattern ×2 + tag edits. | CI build job |
| **T0.6** | `docker compose` dev stack (Postgres, Keycloak, OpenFGA, core, web) for **local + e2e only** — mirrors the shep-infra platform contract so the same image runs in both | NFR-8 | **S** | Some judgment wiring service deps/health ordering; not novel. | Compose smoke test |
| **T0.7** | **shep-infra integration** (cross-repo): Argo `Application` `bootstrap/apps/98-the-company.yaml` → our `infra/overlays/<env>`; widen `projects/apps.yaml` sourceRepos; `setup-the-company.sh` (PG role+DB, Keycloak realm+client, app secrets); ESO `ClusterSecretStore`; pgvector enablement on shared CNPG | NFR-1,8 | **O** | Cross-repo platform change touching the shared cluster (Postgres image, Keycloak, secrets, ArgoCD SoT); blast radius spans co-tenant apps and is the boundary every deploy depends on. Opus per secrets/IaC hard rule. | `kustomize build` + Argo app syncs healthy |

## W1 — Persistence

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T1.1** | Schema + migrations on the shared CNPG `the_company` DB (pgvector-enabled); `org_id` everywhere; RLS for tenant isolation | NFR-2,7 | **O** | Data-model + tenancy-isolation design — security-sensitive and hard to reverse (hard rule: data models are Opus). | Integration (RLS cross-tenant) |
| **T1.2** | Postgres-backed `AuthzEngine` + `AuditSink` + registries behind existing interfaces; preserve audit digest chain | FR-8.4, NFR-7 | **S** | Pattern already proven by the SQLite adapters; implement the same contract on PG. | Integration (digest survives restart) |
| **T1.3** | Durable workflow runs: persist + resume across restart; idempotency/dedupe per external-effect step; run/step inspector data | FR-6.5,6.7, NFR-3 | **F** | Correctness-critical concurrency: a subtle dedupe/idempotency bug double-fires external effects or loses a run — silent, hard-to-detect, data-integrity-class failure. Novel vs the in-memory engine; engine-core (hard rule) + irreversible. | Integration (crash-mid-approval → resume, no double effects) |
| **T1.4** | Seed/migration scripts; demo-org seed via the real tenant path; backup note | NFR-7 | **H** | Mechanical scripting from the schema (T1.1). | Migration smoke test |

## W2 — Identity & multi-tenancy

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T2.1** | OIDC login against the **shared Keycloak** (`auth.shep.bot` realm `the-company`, auth-code+PKCE) in web; token validation in `core`; `Principal` from claims; server session | FR-1.1,1.3 | **O** | Security-critical authn boundary; mistakes are auth-bypass class. Hard rule (auth → Opus). | e2e + integration (token validation) |
| **T2.2** | Swap `InMemoryAuthz` → `OpenFgaAuthz` in `core`; enforce authz+audit on every API/MCP call; remove browser-side authz | FR-1.4,7.2, NFR-1 | **O** | Authorization enforcement boundary — the security spine of the product. Hard rule. | BDD (permission-aware) + security-review |
| **T2.3** | Org lifecycle: create org, invite users, map Keycloak groups→roles→OpenFGA tuples; replace hardcoded seed | FR-1.2,1.3 | **S** | CRUD + mapping against a fixed authz model; known pattern. | BDD (role mapping) |
| **T2.4** | ESO `ExternalSecret`s (Keycloak client secret, OpenFGA store key, DB DSN, Anthropic key, `ghcr-pull`) in the `the-company` ns, from the Infisical `the-company` project — **not** sealed-secrets (ADR-0008) | NFR-1 | **H** | Config from the za-capital `external-secrets.yaml` pattern; mechanical (Opus-reviewed per hard rule on secrets). | `kustomize build` + scan |

## W3 — AI: agents, embeddings, judges

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T3.1** | Real `AgentHandler` over an `AgentProvider` (Anthropic SDK); real token usage → budget meter; retries/timeouts/cap. Runtime model: `claude-opus-4-8` default, per-agent configurable | FR-4.1,4.3, NFR-9 | **O** | Touches the budget/governance metering seam (hard rule: engine-adjacent + cost-control); provider integration design that every agent depends on. | Integration (metering from real usage; hard-stop) |
| **T3.2** | Flagship `extract_meeting` prompt + JSON schema (decisions/risks/customerFacts/actionItems + citations + confidence), grounded on brain context | FR-3.6,8.2 | **S** | Prompt + schema build against the fixed provider seam; iterative, not architecturally novel. | BDD (cited extraction) + eval |
| **T3.3** | Real embeddings + pgvector `MemoryStore`; keep hybrid scoring + permission filter; backfill embeddings | FR-3.1,3.2 | **O** | Core brain IP + retrieval correctness + security filter; hard rule (data model/retrieval). | Integration (semantic match; perm filter holds) |
| **T3.4** | LLM judge for `factuality`/`hallucination_risk` behind `Evaluator`; deterministic pre-filters retained. Runtime model: `claude-sonnet-4-6` (judge), `claude-haiku-4-5` (pre-filter) | FR-8.2,8.3 | **S** | Implement against the existing `Evaluator` interface + gating; known pattern. | Unit + BDD (gate blocks on fail) |
| **T3.5** | Eval thresholds config + fixtures for the flagship policy | FR-8.2 | **H** | Config/fixtures from the schema; mechanical. | Unit |

## W4 — Connectors & ingestion

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T4.1** | Connector SDK v2: OAuth + token refs + backfill/incremental + **faithful source-ACL mapping framework** + conformance kit | FR-2.1,2.2,2.3,2.5, NFR-1 | **F** | *The* permission-aware-brain promise: generic source-ACL→ReBAC mapping that, if wrong, silently leaks data a user shouldn't see. Novel, security-critical, data-leak-class failure; every connector depends on it. | Conformance kit + security-review |
| **T4.2** | Notion connector (read): OAuth, backfill, incremental, ACL capture, ingest — **MVP's first real source** | FR-2.1,2.5 | **S** | Repetitive integration against SDK v2's conformance contract; the framework (T4.1) carries the hard part. | Contract + conformance + integration |
| **T4.3** | Google Drive connector (read) — alternative/second source | FR-2.1,2.5 | **S** | Same pattern as T4.2. | Contract + conformance |
| **T4.4** | Zoom connector, real: API + webhook → fetch transcript → ingest + emit `zoom_transcript` trigger | FR-2.1,6.3 | **S** | Replaces the stub with real API calls on the same contract; known pattern. | Contract + conformance; feeds flagship e2e |
| **T4.5** | Outbound **Slack** notify (real `chat.postMessage`), behind approval gate + idempotency — MVP-required outbound | FR-9.1 | **S** | Real API client behind the existing gate; known pattern. | Contract (no double-send on replay) |
| **T4.6** | Outbound **Jira** create-issue (real API), behind approval gate + idempotency — fast-follow | FR-9.2 | **S** | Same pattern as T4.5. | Contract |
| **T4.7** | Connectors UI: real OAuth connect flow + honest states (connecting/backfilling/connected/error); demo labeling; empty state | FR-2.4 | **S** | React + flow wiring; design judgment on states but not architecturally novel. | e2e (state transitions) |
| **T4.8** | Per-connector OAuth scopes (least-privilege) + ESO `ExternalSecret`s for connector creds + manifests | FR-2.3, NFR-1 | **H** | Config from templates (Opus-reviewed per secrets hard rule). | Integration (least-priv) |
| **T4.9** | Ingestion pipeline: queue/worker, fetch→chunk→embed→upsert→lineage; idempotent; backfill progress to UI | FR-3.1,8.6 | **S** | Build against W3 embeddings + W1 store; known pattern. | Integration (idempotent backfill; lineage) |

## W5 — MCP server

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T5.1** | Real MCP server transport wrapping `McpGateway` (`@modelcontextprotocol/sdk`, Streamable HTTP); OIDC-client→principal→authz/audit; rate limits/budgets | FR-7.1,7.2,7.4,7.5, NFR-1 | **F** | First **external** trust boundary to company data over the network; a gap is an unauthenticated path to the whole brain. No real transport exists today (novel); catastrophic-if-wrong; the whole "MCP-native" wedge depends on it. | Contract + e2e + security-review |
| **T5.2** | MCP tool catalog parity (brain.search/write, skill.run, workflow.trigger, connector tools) + contracts | FR-7.1,7.3 | **S** | Expose existing typed tools over the transport from T5.1; known pattern. | Pact/contract |
| **T5.3** | External-client interop: real Claude/MCP client lists tools, searches brain, triggers workflow under governance | FR-7.5 | **S** | Integration/e2e against the running server; not novel. | e2e (via MCP) |
| **T5.4** | MCP endpoint exposure on `core` + ingress-nginx `Ingress` (`company.shep.bot`, or APISIX if OIDC-at-edge) + network policy | NFR-1,8 | **H** | Manifest/config from the shep-app ingress pattern (Opus-reviewed per network-policy hard rule). | `kustomize build` + policy test |

## W6 — Flagship e2e, observability, security, trust UX

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T6.1** | Rewrite flagship Playwright e2e against the deployed stack (login→Notion→ingest→transcript→real LLM→eval+approval→durable write→Slack→MCP→audit); assert negative path; artifacts | FR-6.6,7.5,8.3 | **O** | Cross-service correctness proof spanning every boundary; defines "done" and gates merges; high blast radius if wrong. | e2e (flagship + negative) |
| **T6.2** | OpenTelemetry traces/metrics/logs across `core`; trace id on every run/MCP call/webhook + audit; export to an **app-owned** collector (no platform OTel backend yet — ADR-0008) | NFR-6 | **S** | Instrumentation pattern; broad but not novel. | Integration (trace propagation) |
| **T6.3** | Trust UX: demo-vs-live labeling, first-run/empty states, async progress, audit export, provenance-forward search | FR-2.4,8.4, NFR-10 | **S** | UX build with judgment; not architecturally novel. | e2e + axe (a11y) |
| **T6.4** | Security pass: authz on every path, no secrets in logs, default-deny netpol, data export/delete + PII tagging | NFR-1,7 | **O** | Cross-cutting security + compliance; mandatory Opus per hard rule (auth/secrets/IaC). | `/security-review` + export/delete BDD |
| **T6.5** | CI: build+push images, boot compose dev stack, run flagship e2e on PR; coverage gates; tag bump in `infra/overlays/<env>` triggers the shep-infra Argo app to sync | NFR-8 | **H** | Pipeline config from existing CI patterns; mechanical. | CI green |
| **T6.6** | Cost/observability dashboard wired to real spend/eval/latency | FR-8.5 | **S** | Dashboard build on real telemetry; known pattern. | e2e (dashboard renders real data) |

## W7 — Lifted deferrals (zero-mock scope, 2026-06-12)

Work the original MVP deferred (`docs/MVP-GAP.md §7`), now in scope because the
target is full integration with no mocks. Each follows the SDK v2 conformance
contract (T4.1) and the brain/store seams already built.

| Task | Description | FR/NFR | Tier | Tier rationale | Test |
| --- | --- | --- | --- | --- | --- |
| **T7.1** | GitHub connector (read): OAuth, repos/issues/PRs backfill + incremental, faithful repo/team ACL mapping, ingest | FR-2.1,2.5 | **S** | Same conformance pattern as Notion (T4.2); SDK v2 carries the hard part. | Contract + conformance + integration |
| **T7.2** | Gmail connector (read): OAuth, message backfill + incremental, per-mailbox ACL, ingest | FR-2.1,2.5 | **S** | Repetitive integration on the fixed contract; ACL is per-owner (simple). | Contract + conformance |
| **T7.3** | Google Calendar connector (read): OAuth, event backfill + incremental, attendee ACL, ingest | FR-2.1,2.5 | **S** | Same pattern as T7.2. | Contract + conformance |
| **T7.4** | Slack connector (read): channel/message backfill + incremental, channel-membership ACL — completes the 8th source | FR-2.1,2.5 | **S** | Read side of the already-real Slack outbound; known pattern. | Contract + conformance |
| **T7.5** | Temporal memory graph (Graphiti-style): entity/edge extraction + time-scoped graph behind `MemoryStore`; hybrid graph+vector retrieval | FR-3.3 | **O** | Core brain IP + retrieval correctness; novel graph model + bitemporal edges, data-model hard rule. | Integration (entity/edge persisted; time-travel query) |
| **T7.6** | Self-serve multi-tenant org creation: create-org API+UI, real tenant provisioning via the T2.3 path (no hardcoded org) | FR-1.2 | **S** | CRUD + provisioning against the fixed authz/tenancy model; not novel. | BDD (new tenant isolated) |

All 8 FR-2.1 connectors real after W4+W7: Notion (T4.2), Drive (T4.3), Zoom
(T4.4), Slack out (T4.5) + read (T7.4), Jira (T4.6), GitHub (T7.1), Gmail
(T7.2), Calendar (T7.3).

---

## Execution order & parallelization

1. **T0.1 (F)** first — it gates everything (ADR-0008 is written; finish the
   architecture test + `infra/` reconcile). **T0.7 (O)** lands the shep-infra
   integration early (it provisions the DB/realm/secrets W1/W2 need). Then **T0.2 (O)**
   fixes the contract.
2. Once the contract is set: **W0 build (T0.3/0.4/0.6)**, **W1 (T1.1→1.2→1.3)**,
   and **W2 (T2.1/2.2)** proceed; T1.1 unblocks most of W1/W3 persistence.
3. **W3** and **W4** run in parallel after W0/W1; T4.1 (F) gates the connectors,
   T3.1 (O)/T3.3 (O) gate the agent/brain.
4. **W5** after the server gateway (W0) + authz (W2).
5. **W6** last; **write T6.1's e2e spec first** — it is the executable DoD.
6. Batch Haiku config/manifest tasks (T0.5, T1.4, T2.4, T3.5, T4.8, T5.4, T6.5).
7. Keep Fable on the critical path only (T0.1, T1.3, T4.1, T5.1); prefer
   "Opus authors → Fable reviews" for any hard-but-not-novel task that tempts a
   fifth Fable assignment.

## Traceability

As tasks complete, add rows to `tasks/traceability-matrix.md` (Req → task → test
layer → PR/artifact), per `docs/05 §5`.
