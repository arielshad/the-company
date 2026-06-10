# MVP Completion Backlog

The authoritative task list to finish the MVP **end-to-end** (the single value
thread in `docs/mvp-completion/00-plan-and-model-strategy.md §1`). Specs:
`docs/mvp-completion/01-technical-specs.md`. Tier rationale model:
`docs/mvp-completion/00-plan-and-model-strategy.md §4`.

**Tier legend:** **F** = Fable 5 (`claude-fable-5`) · **O** = Opus 4.8
(`claude-opus-4-8`) · **S** = Sonnet 4.6 (`claude-sonnet-4-6`) · **H** = Haiku
4.5 (`claude-haiku-4-5`).

Every task carries a **Tier rationale** so the orchestrator knows *why* a model
is needed — not just which. All tasks obey the evidence contract in
`docs/05-development-methodology.md` (red→green, BDD per FR, e2e per journey).

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
