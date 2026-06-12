# Traceability Matrix

Maps every requirement → the phase/tasks that implement it → the test layer that
proves it. Kept current as tasks complete (add the PR + evidence link in the
"Proof" column). This is how we keep delivery **evidence-based**: no requirement
is "met" without a row pointing at a passing test artifact.

## Functional requirements

| Req | Summary | Phase / Tasks | Primary test layer | Proof (PR/artifact) |
| --- | --- | --- | --- | --- |
| FR-1.1 | Keycloak SSO | T00.8, T00.13 | e2e + integration | _pending_ |
| FR-1.2 | Multi-tenant by org | T00.11, T01.1, NFR-2 tasks | integration (RLS) | _pending_ |
| FR-1.3 | Role model | T00.13 | integration | _pending_ |
| FR-1.4 | OpenFGA fine-grained authz | T00.4, T01.7, T02.5 | integration + BDD | _pending_ |
| FR-1.5 | Service-to-service auth | T00.13 | integration | _pending_ |
| FR-2.1 | Connectors (8) | T02.8–10, T06.2–6 | contract + conformance | _pending_ |
| FR-2.2 | Backfill + incremental | T02.2, T06.1 | integration | _pending_ |
| FR-2.3 | Connector OAuth least-priv | T02.11, T06.7 | integration | _pending_ |
| FR-2.4 | Connector health | T02.12, T06.8 | e2e | _pending_ |
| FR-2.5 | Source ACL capture | T02.3, T06.1 | integration | _pending_ |
| FR-3.1 | Ingestion pipeline | T02.1, T02.2 | integration | _pending_ |
| FR-3.2 | Hybrid retrieval | T02.4 | unit + integration | _pending_ |
| FR-3.3 | Temporal memory graph | T02.7 | integration | _pending_ |
| FR-3.4 | Typed memory objects | T02.1 | unit | _pending_ |
| FR-3.5 | Permission-aware search | T02.5 | **BDD (security)** | _pending_ |
| FR-3.6 | Memory write + provenance | T02.6 | BDD | _pending_ |
| FR-3.7 | Memory lifecycle | T02.6 | BDD | _pending_ |
| FR-3.8 | brain.search/write via MCP | T02.13 | contract + BDD | _pending_ |
| FR-4.1 | Agent CRUD | T01.1, T01.2 | BDD | _pending_ |
| FR-4.2 | Org chart | T01.3, T01.10 | unit + e2e | _pending_ |
| FR-4.3 | Budget enforcement | T01.4 | unit + BDD | _pending_ |
| FR-4.4 | Agent templates | T01.5 | unit | _pending_ |
| FR-4.5 | Manual task run | T01.6 | integration | _pending_ |
| FR-4.6 | Activity/eval feed | T01.11, T08.4 | e2e | _pending_ |
| FR-5.1 | Skill package format | T05.1, T05.2 | unit | _pending_ |
| FR-5.2 | Skill sources (Notion/GitHub) | T05.4, T05.5 | integration | _pending_ |
| FR-5.3 | Skill metadata/roles | T05.1, T05.3 | BDD | _pending_ |
| FR-5.4 | Sync engine | T05.4 | integration | _pending_ |
| FR-5.5 | Department namespaces | T05.3, T05.8 | BDD | _pending_ |
| FR-5.6 | Skills runnable | T05.6 | contract + BDD | _pending_ |
| FR-5.7 | Eval-gated promotion | T05.7, T08.3, T08.8 | **BDD (gate)** | _pending_ |
| FR-6.1 | Visual builder | T03.1, T03.5 | unit + e2e | _pending_ |
| FR-6.2 | 13 node types | T03.2, T04.* | unit + integration | _pending_ |
| FR-6.3 | Triggers | T03.3, T04.14 | integration | _pending_ |
| FR-6.4 | DSL compile | T03.4, T03.9 | unit (round-trip) | _pending_ |
| FR-6.5 | Durable execution | T04.1, T04.2 | integration | _pending_ |
| FR-6.6 | Human-in-the-loop | T04.8 | BDD | _pending_ |
| FR-6.7 | Run inspector | T04.13 | e2e | _pending_ |
| FR-6.8 | Workflow versioning | T03.8, T03.9 | e2e | _pending_ |
| FR-6.9 | Per-workflow policies | T03.10 | unit | _pending_ |
| FR-7.1 | MCP tool endpoint | T00.7, T02.13 | contract | _pending_ |
| FR-7.2 | Per-client authz | T00.7, T01.8 | BDD | _pending_ |
| FR-7.3 | Policy-filtered catalog | T01.8 | BDD | _pending_ |
| FR-7.4 | Rate limit + budget + audit | T00.7, T02.13 | integration | _pending_ |
| FR-7.5 | MCP client compatibility | T04.15 (e2e via MCP) | e2e | _pending_ |
| FR-8.1 | Approval policies | T04.8, T08.6 | BDD | _pending_ |
| FR-8.2 | Eval framework | T08.1, T08.2 | unit + integration | _pending_ |
| FR-8.3 | Eval gating | T04.11, T08.3 | BDD | _pending_ |
| FR-8.4 | Immutable audit | T00.5, T07.12, T08.7 | integration | _pending_ |
| FR-8.5 | Cost/observability dashboard | T08.5 | e2e | _pending_ |
| FR-8.6 | Data lineage | T02.15, T08.7 | integration | _pending_ |
| FR-9.1 | Notify channels | T04.12 | contract | _pending_ |
| FR-9.2 | Task actions | T04.10 | contract | _pending_ |

## Non-functional requirements

| Req | Summary | Phase / Tasks | Proof |
| --- | --- | --- | --- |
| NFR-1 | Security | T00.4/7/13/15, T02.5/11, T07.3/4/10 | `/security-review` clean |
| NFR-2 | Tenancy isolation | T00.11, T01.1, T02.16, T07.7 | cross-tenant test suite |
| NFR-3 | Reliability/durability | T04.1/17, T07.1/2/6 | DR drill, restart tests |
| NFR-4 | Performance | T02.17, T07.8 | k6 budgets |
| NFR-5 | Scalability | T04.16, T06.9, T07.9 | autoscale load test |
| NFR-6 | Observability | T00.16, T07.13, T08.5 | traces/metrics/alerts |
| NFR-7 | Compliance | T07.11, T07.12, T08.7 | export/delete BDD, integrity digest |
| NFR-8 | Portability (K8s) | all infra tasks | Argo healthy on CNCF k8s |
| NFR-9 | Cost control | T01.4, T08.5 | metering tests |
| NFR-10 | Accessibility | T03.11 | axe in e2e |

---

## MVP Completion tasks (real e2e thread)

Maps the MVP-completion backlog (`tasks/mvp-backlog.md`) to the requirements each
task makes **real in the running system** (the original phase tasks proved the
logic with in-memory stand-ins; these cross the four reality boundaries — see
`docs/mvp-completion/`). Tier: **F**=Fable, **O**=Opus, **S**=Sonnet, **H**=Haiku.

> **Authoritative status:** `tasks/mvp-backlog.md` → "Status snapshot (2026-06-12)".
> "Proof = PR #4" below means the code/test landed; it does **not** imply the real
> path is the wired default. Gated / partial / mock tasks still have a mock in the
> live flow — see the snapshot.

| Task | Req(s) | Tier | Primary test layer | Proof (PR/artifact) |
| --- | --- | --- | --- | --- |
| T0.1 Server runtime ADR-0008 (browser→server, trust boundary, shep-infra platform boundary) | NFR-1, NFR-2, NFR-8 | F | ADR + compose-boot architecture test | **ADR-0008 + apps/core + infra reconcile** (PR #4); compose smoke in CI |
| T0.2 Typed HTTP API (OpenAPI) replacing platform.ts | FR-6.*, FR-3.*, FR-8.* | O | contract (OpenAPI lint) + unit | **apps/core/openapi.yaml + Fastify routes** (PR #4) |
| T0.3 Fastify API server wiring services in `core` | FR-6.*, FR-8.* | S | integration (API ↔ services) | **apps/core/src/http/server.ts + platform.test.ts** (PR #4) |
| T0.4 Web app → typed API client; loading/error/empty states | FR-6.1, FR-6.7 | S | e2e (pages render via API) | _pending_ |
| T0.5 Dockerfiles for core + web; CI build+push to ghcr | NFR-8 | H | CI build job | **apps/core/Dockerfile + CI image job** (PR #4) |
| T0.6 docker-compose dev stack (PG/Keycloak/OpenFGA) — local/e2e only | NFR-8 | S | compose smoke test | **docker-compose.yml + CI compose-smoke** (PR #4) |
| T0.7 shep-infra integration (Argo app, AppProject src, setup-the-company.sh, ESO store, pgvector) | NFR-1, NFR-8 | O | `kustomize build` + Argo app healthy | **shep-infra PR #20** (Argo app + AppProject + setup script + ESO store); apply pending |
| T1.1 Postgres schema + migrations; RLS tenancy | NFR-2, NFR-7 | O | integration (RLS cross-tenant) | **migrations/0001_init.sql + db adapters**; verified vs real PG16+pgvector (RLS blocks cross-org) (PR #4) |
| T1.2 PG-backed Audit + registries; digest chain | FR-8.4, NFR-7 | S | integration (digest survives restart) | **db/audit.ts** (FNV-1a chain re-derives across restart) (PR #4) |
| T1.3 Durable workflow runs: persist+resume, idempotent effects | FR-6.5, FR-6.7, NFR-3 | F | integration (crash-mid-approval → resume, no double effects) | **resume-on-approve + effect idempotency + flagship.test.ts** (PR #4); full run-state persistence to run_steps pending |
| T1.4 Seed/migration scripts via real tenant path | NFR-7 | H | migration smoke test | _pending_ |
| T2.1 Keycloak OIDC login + token validation + Principal | FR-1.1, FR-1.3 | O | e2e + integration (token validation) | _pending_ |
| T2.2 Server-side OpenFGA authz on every API/MCP call | FR-1.4, FR-7.2, NFR-1 | O | BDD (permission-aware) + `/security-review` | _pending_ |
| T2.3 Org lifecycle; groups→roles→OpenFGA tuples | FR-1.2, FR-1.3 | S | BDD (role mapping) | _pending_ |
| T2.4 ESO ExternalSecrets (Keycloak/OpenFGA/DB/Anthropic) from Infisical | NFR-1 | H | `kustomize build` + scan | _pending_ |
| T3.1 Real AgentHandler (Claude provider) + real budget metering | FR-4.1, FR-4.3, NFR-9 | O | integration (metering from real usage; hard-stop) | 🔌 **Gated**: real Anthropic SDK with `ANTHROPIC_API_KEY`, else `mockExtract` (PR #4). Real-path metering test pending |
| T3.2 Flagship extraction prompt + JSON schema (cited) | FR-3.6, FR-8.2 | S | BDD (cited extraction) + eval | _pending_ |
| T3.3 Real embeddings + pgvector MemoryStore; hybrid + perm filter | FR-3.1, FR-3.2 | O | integration (semantic match; perm filter holds) | _pending_ |
| T3.4 LLM judge (factuality/hallucination) behind Evaluator | FR-8.2, FR-8.3 | S | unit + BDD (gate blocks on fail) | _pending_ |
| T3.5 Eval thresholds config + fixtures | FR-8.2 | H | unit | _pending_ |
| T4.1 Connector SDK v2: OAuth + source-ACL mapping + conformance kit | FR-2.1, FR-2.2, FR-2.3, FR-2.5, NFR-1 | F | conformance kit + `/security-review` | _pending_ |
| T4.1 Connector SDK v2 + source-ACL mapping framework + conformance kit | FR-2.1,2.2,2.3,2.5, NFR-1 | F | conformance kit + security-review | **connectors/sdk.ts (caps + ACL seam + conformance kit)** (PR #4) |
| T4.2 Notion connector (read) — first real source | FR-2.1, FR-2.5 | S | contract + conformance + integration | 🟡 **connectors/notion.ts** (OAuth, backfill, incremental, conservative ACL) (PR #4) — **not yet registered** in `apps/core/src/platform.ts`, so the live flow can't use it |
| T4.3 Google Drive connector (read) | FR-2.1, FR-2.5 | S | contract + conformance | _pending_ |
| T4.4 Zoom connector (real API + webhook → ingest + trigger) | FR-2.1, FR-6.3 | S | contract + conformance; feeds flagship e2e | **connectors/zoom.ts (HMAC verify) + core webhook route** (PR #4) |
| T4.5 Outbound Slack notify (real, gated, idempotent) | FR-9.1 | S | contract (no double-send on replay) | 🟡 **connectors/slack.ts (idempotent postMessage)** (PR #4) — **not wired**: the engine's notify effect is in-memory (`apps/core/src/effects.ts`); real `SlackNotifier` is not connected |
| T4.6 Outbound Jira create-issue (real, gated, idempotent) | FR-9.2 | S | contract | _pending_ |
| T4.7 Connectors UI: real OAuth flow + honest states | FR-2.4 | S | e2e (state transitions) | _pending_ |
| T4.8 Per-connector OAuth scopes + sealed secrets | FR-2.3, NFR-1 | H | integration (least-priv) | _pending_ |
| T4.9 Ingestion pipeline: fetch→chunk→embed→upsert→lineage | FR-3.1, FR-8.6 | S | integration (idempotent backfill; lineage) | _pending_ |
| T5.1 Real MCP server transport + external trust boundary | FR-7.1, FR-7.2, FR-7.4, FR-7.5, NFR-1 | F | contract + e2e + `/security-review` | **apps/core/src/mcp (Streamable HTTP + OIDC boundary + rate limit), client-SDK test** (PR #4) |
| T5.2 MCP tool catalog parity + contracts | FR-7.1, FR-7.3 | S | Pact/contract | _pending_ |
| T5.3 External Claude/MCP client interop | FR-7.5 | S | e2e (via MCP) | _pending_ |
| T5.4 MCP gateway deploy manifest + ingress + netpol | NFR-1, NFR-8 | H | `kustomize build` + policy test | _pending_ |
| T6.1 Flagship Playwright e2e against deployed stack (+ negative path) | FR-6.6, FR-7.5, FR-8.3 | O | e2e (flagship + negative) + artifacts | _pending_ |
| T6.2 OpenTelemetry traces/metrics/logs; trace id on runs | NFR-6 | S | integration (trace propagation) | _pending_ |
| T6.3 Trust UX: demo-vs-live, empty states, async, audit export | FR-2.4, FR-8.4, NFR-10 | S | e2e + axe (a11y) | _pending_ |
| T6.4 Security pass: authz/secrets/netpol + export/delete + PII | NFR-1, NFR-7 | O | `/security-review` + export/delete BDD | _pending_ |
| T6.5 CI: build images, boot stack, run flagship e2e on PR | NFR-8 | H | CI green | _pending_ |
| T6.6 Cost/observability dashboard on real telemetry | FR-8.5 | S | e2e (dashboard renders real data) | _pending_ |
