# PHASE-00 — Platform Foundation (MVP-0)

**Goal:** A deployable, observable, governed skeleton: monorepo + CI, K8s
app-of-apps with Argo CD, Keycloak SSO, OpenFGA, Postgres, Redis, sealed
secrets, observability, and a "hello, authorized world" path through the
gateway. Everything later builds on these patterns.

**Exit criteria:** A user logs in via Keycloak, the web app calls the gateway,
the gateway authenticates the principal and performs an OpenFGA check, and an
audit record is written — all running in the dev cluster via Argo CD, proven by
an e2e test.

**Dominant tiers:** Sonnet (build) with Opus for authz/secret/CI/DSL patterns.

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T00.1 | Monorepo init: pnpm + Turborepo, `apps/`+`packages/`, shared tsconfig/eslint/prettier | — | Haiku | Build runs; lint/typecheck pass |
| T00.2 | `packages/schemas`: Zod models for Agent/Skill/Workflow/Memory/Audit + JSON-Schema gen | FR-* | **Opus** | Unit: schema validation round-trips; golden JSON Schemas |
| T00.3 | `packages/dsl`: DSL types + validator + invariants (1–6 in `03-data-models.md`) | FR-6.4 | **Opus** | Unit (TDD): invalid DSLs rejected with reasons; valid examples accepted |
| T00.4 | `packages/auth`: OIDC verifier + OpenFGA client + principal resolution | NFR-1 | **Opus** | Integration: Testcontainers OpenFGA; allow/deny cases |
| T00.5 | `packages/telemetry`: OTel setup + structured logging + audit client | NFR-6, FR-8.4 | Sonnet | Integration: trace id propagates; audit record persisted |
| T00.6 | `packages/testing`: BDD step lib, Testcontainers helpers, fixtures | — | Sonnet | Self-test of harness |
| T00.7 | `gateway` skeleton: Fastify + MCP SDK; `tools/list` + one `ping` tool with OpenFGA check + audit | FR-7.1–7.4 | **Opus** | BDD: authorized ping allowed; unauthorized denied + audited |
| T00.8 | `web` skeleton: Next.js + Keycloak OIDC login (PKCE) + calls gateway ping | FR-1.1 | Sonnet | e2e: login → ping round-trip |
| T00.9 | CI pipeline: lint→typecheck→unit→integration→bdd→build→scan; coverage + gitleaks + osv + kubeconform | §07 | **Opus** (design) / Sonnet (impl) | CI green on skeleton; gates enforced |
| T00.10 | Dockerfiles + image build/publish for `web`,`gateway` | NFR-8 | Haiku | Images build; run locally |
| T00.11 | Kustomize bases for `web`,`gateway` (Deployment/Service/HPA/NetworkPolicy/SA) | NFR-2,5 | Sonnet | `kustomize build` + kubeconform |
| T00.12 | Platform charts: Keycloak, OpenFGA, Postgres(+pgvector), Redis, sealed-secrets controller | NFR-1 | Sonnet | Render + deploy to dev kind cluster |
| T00.13 | Keycloak realm-as-code + clients + role mapping → OpenFGA sync on login | FR-1.1–1.5 | **Opus** | Integration: login yields principal + relations |
| T00.14 | Argo CD app-of-apps root + per-app Applications; dev overlay | NFR-8 | Sonnet | Argo syncs all apps healthy in dev |
| T00.15 | SealedSecret templates + sealing runbook; wire gateway/keycloak secrets | NFR-1 | **Opus** | No plaintext secret in git (gitleaks); controller decrypts |
| T00.16 | Observability stack (OTel Collector, Prometheus, Grafana, Loki, Tempo) overlay | NFR-6 | Sonnet | Traces/metrics/logs visible for ping path |
| T00.17 | Flagship e2e harness skeleton (Playwright) + CI artifact upload | §05 | Sonnet | e2e login→ping passes; artifacts uploaded |

**Risks / decisions:** ADR-0001 (TS everywhere), ADR-0005 (OpenFGA), ADR-0007
(monorepo), secret-management approach. Authz and DSL are Opus-owned because
every later phase depends on them.
