# MVP Completion — Session Handoff

**Date:** 2026-06-10 · **Branch:** `claude/focused-galileo-e90qcx` · **PR:** #3
**Purpose:** Carry open decisions + context into the next session after this PR merges.

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

## 1. What landed in this PR (done)

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
