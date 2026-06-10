# infra/ — app workloads on the shep-infra platform

**Reconciled per ADR-0008.** the-company runs **on the existing `shep-ai/shep-infra`
platform** (ArgoCD app-of-apps on a 2-node k3s cluster). This repo ships **application
workloads only** (`core`, `web`, app-owned `openfga`); the platform (Postgres,
Keycloak, secrets, ingress) is consumed, not duplicated. See
`../docs/adr/0008-deployment-architecture-and-platform-boundary.md`.

## What the platform provides (do NOT re-create here)

| Need | Provided by shep-infra | How we consume it |
| --- | --- | --- |
| Postgres + pgvector | shared CloudNativePG `shep-pg` (`postgres` ns) | `the_company` role+DB; DSN via ESO secret; `shep-pg-rw.postgres.svc.cluster.local:5432` |
| Identity | shared Keycloak (`auth.shep.bot`) | realm `the-company` + OIDC client (`setup-the-company.sh` in shep-infra) |
| Secrets | Infisical + External Secrets Operator | `ExternalSecret`s sourced from a `ClusterSecretStore` (the za-capital pattern) |
| Ingress / TLS | ingress-nginx (8080) + host Caddy | an `Ingress` for `company.shep.bot` (plain HTTP behind Caddy) |
| GitOps / ArgoCD | root app-of-apps `bootstrap/root-app.yaml` | one `Application` registered in shep-infra → our `infra/overlays/<env>` |

## Layout (target after reconciliation)

```
infra/
├── base/
│   ├── core/        the modular monolith (HTTP API + MCP); Deployment, Service, SA, netpol, hpa
│   ├── web/         thin client; Deployment, Service, Ingress (company.shep.bot)
│   └── openfga/     app-owned authz decision point (ADR-0005); the platform does not run it
├── overlays/        dev / staging / prod — image tags + env patches
└── external-secrets/  ESO ExternalSecrets (DB DSN, Keycloak client secret, OpenFGA key,
                       Anthropic key, connector OAuth creds, ghcr-pull)
```

> **Migration note (T0.1/T0.7):** the previous layout — a self-owned root app-of-apps
> (`argocd/app-of-apps.yaml`, `argocd/project.yaml`), self-hosted platform
> (`platform/{postgres,keycloak,qdrant,redis,sealed-secrets,trigger}`,
> `sealed-secrets/`), and a nine-service `base/` — is **superseded** and being removed.
> shep-infra is the single ArgoCD SoT; the nine-service base is the *future* split
> target (ADR-0008), not the MVP topology, which is `core` + `web`.

## How it deploys

shep-infra registers one Argo `Application` (`bootstrap/apps/98-the-company.yaml`)
pointing at `https://github.com/arielshad/the-company` → `infra/overlays/<env>`,
syncing into the `the-company` namespace. shep-infra's `apps` `AppProject` allows this
repo as a source.

**Promotion** = a reviewed PR bumping the image tag in the target overlay's
`kustomization.yaml`; ArgoCD detects it and syncs. Images:
`ghcr.io/arielshad/the-company-{core,web}`, pulled via the `ghcr-pull` secret.

## Secrets

No plaintext secrets in git. Values live in the Infisical `the-company` project and
surface as k8s `Secret`s via ESO `ExternalSecret`s. **Sealed-secrets is not used on
this platform.**

## Local validation (run in CI)

```bash
for env in dev staging prod; do
  kustomize build infra/overlays/$env | kubeconform -strict -summary
done
kube-linter lint infra/
checkov -d infra/
```

These run as the `IaC scan` and `Manifest validity` gates in CI
(`../docs/07-quality-gates.md §1`). Tooling is not installed in this repo's
scaffolding container — validation happens in the pipeline.

## Prerequisites

The shep-infra platform (above) up and reachable: shared CNPG with pgvector enabled
on the `the_company` DB, shared Keycloak with the `the-company` realm, ESO +
Infisical, ingress-nginx + Caddy. Provisioned by `setup-the-company.sh` in shep-infra.
```
