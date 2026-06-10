# ADR-0008 — Deployment architecture & the shep-infra platform boundary

**Status:** Accepted · 2026-06-10
**Supersedes/refines:** ADR-0003 (durable execution), ADR-0004 (vector store) for
the MVP horizon. Keeps ADR-0005 (OpenFGA), ADR-0006 (MCP gateway), ADR-0007 (monorepo).
**Gates:** T0.1 and the whole `infra/` story; see `tasks/mvp-backlog.md`.

## Context

Two decisions were held open in `docs/mvp-completion/HANDOFF.md`:

1. **Runtime topology** for the MVP — modular monolith vs hybrid vs microservices.
2. **How to treat the existing `shep-ai/shep-infra` platform**, which the prior
   session could not read.

This session has read `shep-ai/shep-infra`. The platform is concrete and already
runs, which changes the plan in specific ways. What shep-infra actually provides
(GitOps source of truth, ArgoCD app-of-apps onto a small k3s cluster, 2 nodes):

| Capability | What runs in shep-infra | Implication for the-company |
| --- | --- | --- |
| **Postgres** | One shared **CloudNativePG** cluster `shep-pg` (`postgres` ns); per-app DB+role; reachable at `shep-pg-rw.postgres.svc.cluster.local:5432` | Consume it. Add a `the_company` role+DB; do **not** ship our own Postgres StatefulSet. |
| **Secrets** | **Infisical** (`vault.shep.bot`) + **External Secrets Operator** (`ExternalSecret` + `ClusterSecretStore`) | Use ESO. **Sealed-secrets is not used on this platform** — drop it from our plan. |
| **Identity** | Shared **Keycloak** (`auth.shep.bot`, codecentric keycloakx chart), realm+client per app | Create a `the-company` realm + OIDC client on the shared Keycloak; do **not** stand up our own Keycloak. |
| **Ingress / TLS** | ingress-nginx (host port 8080, default) and APISIX (32080, for OIDC-edge apps); host **Caddy** terminates TLS for `*.shep.bot` | Get a `company.shep.bot` subdomain with an ingress-nginx `Ingress` (plain HTTP behind Caddy). |
| **GitOps** | Root app-of-apps `bootstrap/root-app.yaml` → `bootstrap/apps/*`; each app is one Argo `Application`; **manifests live in the repo the Application points at** | shep-infra is the single ArgoCD SoT. Our app is registered as one `Application` there. |
| **Not provided** | No OpenFGA, no Qdrant, no Trigger.dev/Temporal, no app-level OTel/observability backend | Anything we need beyond the above we bring as **app-owned** workloads in our own namespace. |

The README's "single-node" note is stale; the cluster is **2 nodes** and the
product goal is a **scalable** system. That goal is satisfied by a clean split
*path*, not by premature decomposition (see below).

## Decision

### 1. Runtime topology — modular monolith, split-ready

Ship the MVP as a **modular monolith**: one `apps/core` Deployment that imports the
existing packages (`brain`, `governance`, `agent-registry`, `skill-registry`,
`workflow-engine`, `gateway`, `auth`, `telemetry`, `connectors`) and exposes the
HTTP/JSON API (Fastify) plus the MCP server, with **all authorization and audit
enforced server-side**. Plus `apps/web` (thin client). The nine `apps/*` stay as
library modules — they already are.

Why monolith-first even on a scalable, multi-node target:

- **The MVP bottleneck is correctness/integration, not scale.** Microservices add
  network hops and distributed transactions during the exact correctness-critical
  work — notably T1.3 (durable runs spanning brain+governance+workflow+gateway),
  which is **one transaction in a monolith** and a **saga across services**.
- **Code architecture ≠ deployment topology.** ArgoCD deploys one `core` as happily
  as nine services. A 2-node cluster is not a reason to split the code now.
- **The split is mechanical, not a rewrite.** The `apps/*` are already clean module
  boundaries, so "promote a package to its own Deployment + Argo Application" is a
  later, low-risk move. Scalability is preserved by *keeping the seams crisp*, which
  the modular monolith does, and which this ADR makes a build constraint.

**Split-later criteria (record and honor):** break out `connectors` first (untrusted
third-party tokens + independent sync scaling), the MCP `gateway` second (external
network exposure + rate-limit/security boundary), `brain` ingestion third (embedding
throughput). Until a service hits one of those triggers, it stays in `core`.

### 2. Platform boundary — shep-infra is the platform SoT; the-company ships workloads

the-company **consumes** shep-infra's platform and ships only its application
workloads:

- **Postgres:** shared CNPG cluster. A `the_company` role+DB is provisioned out of
  band (see `bootstrap/setup-the-company.sh` in shep-infra, mirroring
  `setup-shep-cloud.sh`). One logical DB holds relational + vector data.
- **Vector store: pgvector on the shared Postgres** (confirms ADR-0004's "pgvector
  primary"; **Qdrant deferred**). This requires the CNPG cluster image to bundle the
  `vector` extension and `CREATE EXTENSION vector` in the `the_company` DB — a
  platform change captured as an action below.
- **Identity:** Keycloak realm `the-company` + confidential OIDC client (auth-code +
  PKCE). `core` validates tokens and builds the `Principal` from claims; the browser
  is never trusted.
- **Secrets:** Infisical project `the-company` surfaced via an ESO
  `ClusterSecretStore` + per-namespace `ExternalSecret`s (DB DSN, Keycloak client
  secret, connector OAuth creds, Anthropic API key, `ghcr-pull`). **No sealed-secrets.**
- **Authorization:** OpenFGA stays the single decision point (ADR-0005) but is an
  **app-owned** workload in the `the-company` namespace (the platform does not run it).
- **Durable execution: Postgres-native** for the MVP (run/step state + idempotency
  keys in the shared Postgres). **Trigger.dev/Temporal deferred** (refines ADR-0003).
- **Observability:** app-owned OpenTelemetry instrumentation in `core`. The platform
  has no OTel collector/backend yet, so for the MVP traces stay in-process / exported
  to an app-owned collector; a shared backend is a later platform addition.
- **Ingress:** an ingress-nginx `Ingress` for `company.shep.bot` (plain HTTP behind
  Caddy on-host TLS), mirroring the `shep-app` ingress. APISIX only if we later need
  OIDC enforced at the edge.

### 3. GitOps ownership — manifests in the-company, registered once in shep-infra

Per the platform owner's call, **manifests live in the the-company repo** (`infra/`,
Kustomize bases+overlays). shep-infra registers **one** Argo `Application`
(`bootstrap/apps/98-the-company.yaml`) that points at
`https://github.com/arielshad/the-company` → `infra/overlays/<env>`, deploying into
the `the-company` namespace. shep-infra's `apps` `AppProject` is widened to allow the
the-company repo as a source.

Consequences for our `infra/`:

- **Retire** the-company's own root app-of-apps (`infra/argocd/app-of-apps.yaml`) and
  `project.yaml` — shep-infra's `bootstrap/root-app.yaml` is the only ArgoCD SoT.
- **Delete the platform-stand-up duplicates** we no longer own:
  `infra/platform/{postgres,keycloak,qdrant,redis,sealed-secrets,trigger}` and
  `infra/sealed-secrets/`.
- **Collapse** the nine-service Kustomize base to **`core` + `web`** (+ the app-owned
  `openfga`), matching decision 1; the nine-Deployment base is the *future* split
  target, not the MVP topology.
- **Add** ESO `ExternalSecret`s + the `company.shep.bot` `Ingress` to our app bases.
- **Image/registry:** `ghcr.io/arielshad/the-company-core` and `...-web`, pulled via
  a `ghcr-pull` secret, mirroring shep-app. CI builds + tags; promotion is a PR that
  bumps the tag in `infra/overlays/<env>`.

## Consequences

- The W1/W2/W6 "stand up platform" work **shrinks** to "point `core` at existing
  platform services + one Argo Application + ESO secrets + a Keycloak realm" — at the
  cost of a hard dependency on shep-infra availability and conventions.
- One deploy unit and one transaction boundary make the durable-run correctness work
  (T1.3) tractable; the split path keeps the scalability goal open.
- Two cross-repo actions are now required and tracked (see below): a shep-infra PR to
  register the app + provision DB/secrets/realm, and the pgvector image enablement on
  the shared cluster.
- ADR-0003 and ADR-0004 are **refined for the MVP** (Postgres-native durability;
  pgvector-only); their "at scale" options remain valid future work, not deleted.

## Required platform actions (in shep-infra)

1. `bootstrap/apps/98-the-company.yaml` — Argo `Application` → the-company `infra/overlays/<env>`.
2. `projects/apps.yaml` — add `https://github.com/arielshad/the-company` to `sourceRepos`.
3. `bootstrap/setup-the-company.sh` — provision `the_company` PG role+DB, Keycloak realm+client, app secrets.
4. ESO `ClusterSecretStore` for the Infisical `the-company` project.
5. **pgvector enablement:** swap the shared CNPG image for a build bundling pgvector,
   and `CREATE EXTENSION vector` in the `the_company` DB. (Image change is platform-wide;
   pgvector images are supersets and safe for co-tenants, but it is a deliberate platform PR.)
