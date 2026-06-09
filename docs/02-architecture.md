# 02 — Architecture

## 1. Logical architecture

```
                   Claude / Cursor / ChatGPT / Claude Code / Internal UI
                                        |
                                        v
                                   MCP Gateway  ──(OIDC + OpenFGA on every call)
                                        |
                                        v
                          Company Agent OS / Brain API (BFF)
                                        |
        --------------------------------------------------------------------
        |                    |                      |                    |
   Workflow Builder     Agent Runtime          Company Brain        Governance
   (React Flow UI)      (Workflow Engine)      (RAG + memory)       (OpenFGA + audit)
        |                    |                      |                    |
   Workflow DSL         VoltAgent / LangGraph   pgvector / Qdrant    OpenFGA
                        Trigger.dev → Temporal  Graphiti graph       Audit log
        --------------------------------------------------------------------
                                        |
                                        v
                       Connectors / MCP Servers / Webhooks
            Notion · Drive · GitHub · Slack · Gmail · Calendar · Zoom · Jira
```

## 2. Services (each = one Argo CD Application)

| Service | Responsibility | Stack | Stateful? |
| --- | --- | --- | --- |
| `web` | Builder UI, dashboards, admin | Next.js + React + React Flow | no |
| `gateway` | MCP endpoint + BFF/API gateway; authn/authz enforcement point | Fastify (Node/TS) + MCP SDK | no |
| `agent-registry` | Agents, roles, org chart, budgets | Fastify + Postgres | no (DB) |
| `brain` | Ingestion, RAG search, memory CRUD, embeddings | Fastify + pgvector + Graphiti + Qdrant(opt) | no (DB/vector) |
| `workflow-engine` | DSL validation, durable execution, run inspector API | VoltAgent/LangGraph + Trigger.dev | no (jobs in DB) |
| `skill-registry` | Skill packages, versioning, source sync | Fastify + Postgres | no (DB) |
| `governance` | OpenFGA integration, approvals, evals, audit, cost | Fastify + OpenFGA + Postgres | no (DB) |
| `connectors` | Connector workers (one deployment, per-connector workers) | Node/TS workers | no (queues) |
| `eval-service` | Eval runners (quality/factuality/policy) | Node/TS + LLM judge | no |

### Platform dependencies (PHASE-00, in `infra/platform/`)

| Component | Purpose | Notes |
| --- | --- | --- |
| **Keycloak** | OIDC SSO, users/groups/roles, service clients | Realm-as-code |
| **OpenFGA** | Relationship-based authorization | Model-as-code, store per env |
| **PostgreSQL** | Primary OLTP + pgvector extension | One logical DB per service, RLS for tenancy |
| **Redis** | Cache, rate limits, ephemeral run state | |
| **Qdrant** | Optional vector store at scale | pgvector is default |
| **Trigger.dev** | Durable job/workflow execution (MVP) | Temporal added in PHASE-07 |
| **NATS / Redis Streams** | Connector event bus | |
| **Sealed Secrets controller** | Decrypt SealedSecrets in-cluster | Bitnami sealed-secrets |
| **Object storage (S3 API)** | Raw documents, transcripts, artifacts | MinIO in dev, cloud S3 in prod |
| **OTel Collector + Prometheus + Grafana + Loki + Tempo** | Observability | |

## 3. Technology decisions (see `docs/adr/` for rationale)

- **Language:** TypeScript/Node everywhere (matches team; VoltAgent is TS-first). Python only if a brain/eval component requires it, isolated behind an API. → ADR-0001
- **Agent runtime:** VoltAgent for TS-native agents + supervisor coordination; LangGraph kept as an option behind the DSL compiler boundary. → ADR-0002
- **Durable execution:** Trigger.dev for MVP velocity; Temporal for PHASE-07 durability/scale. The workflow engine abstracts the executor so this swap is contained. → ADR-0003
- **Brain:** pgvector primary (simpler ops), Qdrant optional at scale; Graphiti for temporal memory graph; Onyx studied for retrieval patterns, not a hard dependency. → ADR-0004
- **Authz:** OpenFGA (ReBAC) — the single decision point used by gateway and every service. → ADR-0005
- **MCP:** Official MCP SDK; gateway is a policy-enforcing MCP server (consider IBM ContextForge patterns). → ADR-0006
- **Monorepo:** Nx/Turborepo + pnpm workspaces; shared `packages/` for DSL, schemas, auth, telemetry. → ADR-0007

## 4. Repository layout (target, created during PHASE-00)

```
apps/
  web/                Next.js frontend
  gateway/            MCP gateway + BFF
  agent-registry/
  brain/
  workflow-engine/
  skill-registry/
  governance/
  connectors/
  eval-service/
packages/
  dsl/                Workflow DSL types, validators, compiler
  schemas/            Zod/JSON-Schema for Agent/Skill/Workflow/Memory
  auth/               OIDC + OpenFGA client helpers
  mcp/                Shared MCP server/client utilities
  telemetry/          OTel setup, logging, audit client
  testing/            Test harness, fixtures, BDD step libs
e2e/                  Playwright + scenario suites
infra/                (this repo) — GitOps manifests
docs/                 (this repo) — spec & phases
```

> The application code lives under `apps/` and `packages/` and is built in the
> phases; `infra/` and `docs/` are scaffolded now.

## 5. Deployment architecture (Kubernetes, GitOps)

- **GitOps tool:** Argo CD, **app-of-apps** pattern. A root `Application`
  (`infra/argocd/app-of-apps.yaml`) points at `infra/argocd/apps/` which
  contains one `Application` per service + one per platform component.
- **Packaging:** Kustomize. `infra/base/<svc>` holds the base; `infra/overlays/<env>`
  patches replicas, resources, image tags, hostnames, config.
- **Environments:** `dev`, `staging`, `prod` — same bases, different overlays;
  promotion = changing an image tag/ref in the overlay (PR-reviewed).
- **Secrets:** Bitnami **Sealed Secrets**. Plaintext never enters git; only
  `SealedSecret` CRs do; the controller decrypts in-cluster. See `infra/sealed-secrets/`.
- **Auth at the edge:** Ingress (NGINX/Gateway API) → OIDC via Keycloak;
  `gateway` validates tokens and is the authz enforcement point.
- **Networking:** NetworkPolicies default-deny; only declared service-to-service
  paths allowed; mTLS via service mesh optional (Linkerd) in PHASE-07.
- **Namespaces:** `companyos-platform` (Keycloak, OpenFGA, data stores),
  `companyos-system` (services), per-env clusters or namespaces.

```
Argo CD (root app-of-apps)
└── infra/argocd/apps/
    ├── platform-keycloak.yaml      → infra/platform/keycloak
    ├── platform-openfga.yaml       → infra/platform/openfga
    ├── platform-postgres.yaml      → infra/platform/postgres
    ├── platform-redis.yaml         → infra/platform/redis
    ├── platform-qdrant.yaml        → infra/platform/qdrant
    ├── platform-sealed-secrets.yaml→ infra/platform/sealed-secrets
    ├── platform-trigger.yaml       → infra/platform/trigger
    ├── svc-web.yaml                → infra/overlays/<env> (web)
    ├── svc-gateway.yaml
    ├── svc-agent-registry.yaml
    ├── svc-brain.yaml
    ├── svc-workflow-engine.yaml
    ├── svc-skill-registry.yaml
    ├── svc-governance.yaml
    ├── svc-connectors.yaml
    └── svc-eval-service.yaml
```

## 6. Data flow: ingestion → memory → retrieval

```
Connector (webhook/poll) → raw object to object-store + event on bus
  → brain ingestion worker: extract → chunk → embed → upsert (pgvector)
      + extract entities/edges → Graphiti graph (valid-time)
      + capture source ACL → store with object for permission-aware retrieval
  → searchable via brain.search (hybrid: vector + BM25 + recency + permission filter)
```

## 7. Data flow: workflow run

```
Trigger fires → workflow-engine loads published DSL version
  → executes nodes durably (each node = idempotent step with dedupe key)
  → Agent nodes call provider via budget-metered client (cost recorded)
  → Tool/MCP nodes call gateway (OpenFGA checked, audited)
  → Approval node pauses → notify approver → resume on decision
  → Memory Write / Task / Notify nodes apply effects
  → Eval node gates external effects per evalPolicy
  → run record (per-node IO, cost, trace id) stored for inspector & audit
```

## 8. Cross-cutting

- **Trace propagation:** every external entry (HTTP, MCP, webhook, trigger)
  starts/continues an OTel trace; trace id stored on run + audit records.
- **Idempotency:** all external-effect operations require an idempotency key.
- **Tenancy:** `org_id` on every row; Postgres RLS; vector namespaces per org;
  OpenFGA object ids namespaced by org.
- **Config:** 12-factor; all config via env/ConfigMap; secrets via SealedSecret;
  no environment-specific code.
