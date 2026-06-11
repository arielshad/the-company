# MVP Completion — Session Handoff

**Updated:** 2026-06-11 · **Active branch:** `claude/bold-lamport-djba7w` ·
**PRs:** the-company #4, shep-infra #20 (planning history: PR #3 on `claude/focused-galileo-e90qcx`)
**Purpose:** Carry open decisions + build state into the next session.
**Read order:** §0 (decisions) → §0.5 (build state, start here for code) → `docs/adr/0008`.

---

## 0. RESOLVED in session 2 (2026-06-10) — read `docs/adr/0008` first

Both open decisions below are now **resolved** in
[`../adr/0008-deployment-architecture-and-platform-boundary.md`](../adr/0008-deployment-architecture-and-platform-boundary.md),
after gaining read access to `shep-ai/shep-infra`.

- **Decision 1 (architecture) → modular monolith, split-ready.** Confirmed by the
  platform owner (delegated); cluster is **2 nodes**, scalability goal met by the
  documented split *path*, not premature decomposition. Split-later criteria in ADR-0008.
- **Decision 2 (platform) → shep-infra is the platform SoT; the-company ships
  workloads.** Manifests stay **in the the-company repo**, registered as **one** Argo
  `Application` in shep-infra. Vector store = **pgvector on the shared CNPG**.
- **Corrections to this handoff's earlier guesses:** the platform uses
  **Infisical + External Secrets Operator, NOT sealed-secrets**; there is **no
  platform OTel backend** (app-owned OTel for MVP); **no OpenFGA/Qdrant/Trigger.dev**
  on the platform (OpenFGA is app-owned; Qdrant/Trigger.dev deferred). Keycloak +
  Postgres are **shared** and consumed, not stood up.

What landed in session 2: `docs/adr/0008`, reconciled `01-technical-specs.md` /
`00-plan-and-model-strategy.md` / `tasks/mvp-backlog.md` (+ new **T0.7** shep-infra
integration) / `tasks/traceability-matrix.md` / `infra/README.md`, and the shep-infra
integration glue (Argo `Application`, AppProject source, `setup-the-company.sh`, ESO
`ClusterSecretStore`) on branch `claude/bold-lamport-djba7w` in both repos.

**Next-session first actions:** execute **T0.7** (apply the shep-infra glue: register
the Argo app, run `setup-the-company.sh`, enable pgvector on the shared cluster), then
**T0.1 remaining** (`infra/` reconcile: delete `infra/{argocd,platform,sealed-secrets}`
duplicates, collapse `base/` to `core`+`web`+`openfga`) → **T0.2** API contract.

The sections below are the original (now-resolved) decision write-ups, kept for context.

---

## 0.5 BUILD session (2026-06-11) — `apps/core` spine is real and green

Branch `claude/bold-lamport-djba7w` · PRs **the-company #4**, **shep-infra #20**.
**Status: 187 tests pass / 11 skipped, typecheck clean.** The infra `T0.1` reconcile
(delete `infra/{argocd,platform,sealed-secrets}`, collapse `base/` → `core`+`web`+
app-owned `openfga`+ESO) is **done** — that first-action above is complete.

### Done (with tests)
| Task | What landed |
| --- | --- |
| **T0.1** | `apps/core` modular monolith; infra reconciled to core/web/openfga (ADR-0008) |
| **T0.2/T0.3** | `apps/core/openapi.yaml` + Fastify HTTP API — a typed endpoint per former `platform.ts` method; brain/workflow calls route through the MCP gateway so API + MCP share one authz+audit path |
| **T0.5/T0.6** | `apps/core/Dockerfile`, `docker-compose.yml` (fast sqlite path + `platform` profile), CI core image + compose-smoke |
| **T1.1/T1.2/T3.3** | `apps/core/migrations/0001_init.sql` (schema, RLS keyed on `app.org_id`, pgvector, append-only audit) + `db/{pool,audit,memory-store,migrate,postgres-stores}.ts`. **Verified against real PG16+pgvector**: RLS blocks cross-org, audit FNV-1a digest chain re-derives across restart. Adapters keep a write-through in-memory mirror so the sync `AuditSink`/`MemoryStore` interfaces are honored. |
| **T1.3 (slice)** | Durable resume: `decideApproval` finds the paused run (`engine.findRunByApproval`) and resumes it; effects past the gate run **exactly once** (resume continues from `resumeFrom`); effect idempotency ledger keyed by meeting+node. Flagship completes after approve; reject → no effects. |
| **T3.1** | Real Anthropic `AgentHandler` seam (`agent-provider.ts`), mock fallback when no `ANTHROPIC_API_KEY` |
| **T4.1/4.2/4.4/4.5** | Connector SDK v2 + conformance kit; Notion (read, OAuth, conservative ACL mapping); real Zoom (HMAC verify); idempotent Slack `chat.postMessage`. Inbound webhook plumbed in core: `POST /api/connectors/:name/webhook` → ingest → trigger the matching workflow as the run-as agent. |
| **T5.1** | Real MCP server (`@modelcontextprotocol/sdk` Streamable HTTP) at `/mcp`; external OIDC trust boundary resolved server-side per request; per-principal token-bucket rate limit; policy delegated unchanged to the gateway. Driven by the MCP client SDK in tests. |

The full flagship thread runs e2e in-memory today: **zoom webhook → ingest → extract →
eval gate → approval (pause) → resume → memory write → effects (once) → audit**, governed.

### Key seams left open (for the next session, in priority order)
1. **T0.7 (do first, ops):** apply the shep-infra glue — register the Argo app, run
   `setup-the-company.sh`, **swap the shared CNPG image to a pgvector build** + `CREATE
   EXTENSION vector` in `the_company`. Until then prod (`PERSISTENCE=postgres`) can't boot;
   local/CI use sqlite/memory.
2. **T2.1/T2.2/T2.3 identity enforcement:** OIDC verify exists (`auth/session.ts`, jose
   JWKS) + `OpenFgaAuthz` adapter exists, but enforcement is not yet on **every** endpoint
   and the real Keycloak `the-company` realm isn't wired. Need: create realm/client via
   setup script, set `AUTHZ_BACKEND=openfga` + write the model to the app-owned OpenFGA
   (`setupOpenFgaStore`), and add per-endpoint `governance.authorize` beyond the
   gateway-routed calls. Tenancy (org lifecycle) still seeds via `seedDemo`.
3. **Finish T1.3:** persist run/run_steps to Postgres (the `runs`/`run_steps` tables +
   `(org_id, idempotency_key)` unique index exist; the engine still holds runs in-memory).
   This is what makes "crash mid-approval → resume" survive a real restart.
4. **T3.3 embeddings wiring:** `PostgresMemoryStore.setEmbedding/searchByVector` (cosine)
   exist; wire an `Embedder` into `brain.ingest` + use vector search in `brain.search`.
5. **T3.4 LLM judges, T4.3 Drive, T4.6 Jira, T0.4 web→API client, T6.1 Playwright e2e on
   the deployed stack, T6.2 OTel, T6.3 trust UX, T6.4 security pass, T6.6 dashboard.**

### How to run what exists
- `pnpm test` (187 green) · `pnpm typecheck` · `docker compose up core web` (sqlite, dev-auth).
- Real PG integration tests: set `DATABASE_URL` (+ run `pnpm --filter @companyos/core migrate`).
- Persistence/authz are env-selected in `apps/core/src/config.ts`
  (`PERSISTENCE` = memory|sqlite|postgres, `AUTHZ_BACKEND` = memory|sqlite|openfga).

---

## 1. What landed in PR #3 (the planning PR — done)

| Artifact | Path |
| --- | --- |
| Gap analysis (mock vs real, path to value) | `docs/MVP-GAP.md` |
| MVP completion plan + four-tier model strategy (Fable/Opus/Sonnet/Haiku) | `docs/mvp-completion/00-plan-and-model-strategy.md` |
| Per-workstream technical specs (W0–W6) | `docs/mvp-completion/01-technical-specs.md` |
| 38-task backlog with per-task tier rationale | `tasks/mvp-backlog.md` |
| Traceability rows for T0.1–T6.6 | `tasks/traceability-matrix.md` (new section) |

Reference framing: the MVP is the single e2e value thread (login → real Notion
ingest → real Claude extraction → eval+approval gate → durable write → Slack →
MCP retrieval → audit), built by crossing four reality boundaries (runtime,
persistence, intelligence, connectivity/identity).

---

## 2. OPEN DECISION 1 — Deployment architecture (gates ADR-0008 / task T0.1)

**Decision needed:** modular monolith vs hybrid vs full microservices for the MVP.

**Recommendation: modular monolith, split-ready.** One `core` Deployment hosting
the existing packages behind HTTP+MCP, module boundaries preserved.

Why (independent of how rich the cluster is):
- Code architecture ≠ deployment topology — ArgoCD deploys one `core` as happily
  as nine services. A mature cluster is **not** a reason to split the code.
- The MVP bottleneck is **correctness/integration**, not scale. Microservices add
  network hops + distributed transactions during the exact correctness-critical
  work (esp. T1.3 durable runs spanning brain+governance+workflow+gateway, which
  is one transaction in a monolith, a saga across services).
- The nine `apps/*` are already clean library modules → a later split is "promote
  a package to its own Deployment + Argo App," mechanical, not a rewrite.
- The existing 9-service Argo manifests remain the **target** topology, not the
  MVP topology.

**Split-later criteria to record in ADR-0008:** break out `connectors` first
(untrusted tokens + sync scaling), `gateway`/MCP second (external exposure +
rate-limit + security boundary), `brain` ingestion third (throughput). Else keep
in `core`.

**Options on the table (next session to confirm):**
1. Modular monolith, split-ready — **recommended**.
2. Hybrid — monolith `core` + `connectors` and MCP `gateway` split from day one.
3. Full microservices now — matches existing manifests; max operational surface.

**Next-session action:** confirm option, then write **ADR-0008** and adjust
`apps/` (add `apps/core`) + `infra/` manifests to match. T0.1 is the Fable-tier
task that produces this ADR.

---

## 3. OPEN DECISION 2 — How to treat the existing `shep-ai/shep-infra` platform

**Context / blocker:** the user has an existing k8s + ArgoCD platform at
`https://github.com/shep-ai/shep-infra`. **This session could not read it** —
`WebFetch` returned 404 (private), GitHub MCP access is scoped to
`arielshad/the-company`, and no repo-add tool was available. So the infra-specific
parts of the plan are still written against the-company's own `infra/` templates.

**How it affects the plan (conditional on what shep-infra actually runs):**
- If Postgres/Keycloak/OpenFGA/ingress/sealed-secrets/OTel already run there,
  the W1/W2/W6 "stand up platform" tasks **shrink** to "point `core` at existing
  platform services + add one app-level Argo `Application` + sealed secrets."
- `infra/platform/*` in the-company likely becomes **redundant** — consume
  shep-infra, don't duplicate it.
- Likely clean split: **shep-infra = platform + Argo root app-of-apps (SoT);
  the-company = app images + per-app manifests** referenced by shep-infra's
  app-of-apps. This rewrites T0.5, T2.4, T5.4, T6.5 and the `infra/` story.

**Recommendation:** treat shep-infra as the **platform source of truth**; the
the-company repo ships application workloads only.

**Options on the table (next session to confirm):**
1. Platform SoT — app ships workloads only — **recommended**.
2. Grant read access first (add `shep-ai/shep-infra` to the session, or paste its
   tree/README) so ADR-0008 + infra tasks are tailored to exactly what exists.
3. Keep the-company's own `infra/` (risks duplicating shep-infra).

**Next-session action (do this first):** get read access to `shep-ai/shep-infra`
— either add it to the session's repo scope or have the user paste the top-level
tree + which platform components (Postgres/Keycloak/OpenFGA/ingress/secrets/Argo)
already run. Then:
- reconcile `the-company/infra/` against shep-infra (delete duplicated platform
  manifests; keep only app-level Deployment/Service/Ingress/Argo `Application`),
- update ADR-0008 and tasks T0.5/T2.1/T2.2/T2.4/T5.4/T6.5 to consume the existing
  platform,
- confirm the ownership boundary (who owns the Argo root app-of-apps; how app
  image tags get promoted into shep-infra overlays).

---

## 4. First actions for the next session

1. **Unblock infra:** obtain read access to `shep-ai/shep-infra` (Decision 2,
   option 2) — this is the prerequisite to finalizing the infra tasks.
2. **Confirm Decision 1** (architecture) — default to modular monolith unless the
   user says otherwise.
3. **Write ADR-0008** capturing both decisions (runtime architecture + "platform
   provided by shep-infra; app ships workloads only") with the split-later
   criteria.
4. **Reconcile `infra/`** in the-company against shep-infra; update the affected
   tasks + traceability rows.
5. Begin execution at **T0.1 → T0.2** (the architecture + API contract that gate
   the rest), per `tasks/mvp-backlog.md` execution order.
