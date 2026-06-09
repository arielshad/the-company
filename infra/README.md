# infra/ — GitOps Infrastructure-as-Code

Declarative, GitOps-managed deployment of CompanyOS to Kubernetes using the
**Argo CD app-of-apps** pattern, **Kustomize** bases/overlays, **Bitnami Sealed
Secrets**, **Keycloak** (OIDC SSO), and **OpenFGA** (authorization). See
`../docs/02-architecture.md §5` for the deployment architecture.

## Layout

```
infra/
├── argocd/
│   ├── app-of-apps.yaml      Root Application → syncs everything in apps/
│   ├── project.yaml          AppProject "companyos" (repo + namespace allowlist)
│   └── apps/                 One Application per platform dep + the services app
├── base/                     Kustomize bases, one dir per service
│   └── <svc>/                deployment, service, sa, networkpolicy, hpa, kustomization
├── overlays/                 Per-env patches
│   ├── dev/  staging/  prod/
├── platform/                 Platform dependencies (referenced by Argo apps)
│   ├── keycloak/  openfga/  postgres/  redis/  qdrant/
│   ├── sealed-secrets/  trigger/
└── sealed-secrets/           SealedSecret CRs (encrypted; safe to commit) + runbook
```

## How it deploys (app-of-apps)

```
Argo CD installed in cluster
  └── apply infra/argocd/project.yaml        (AppProject companyos)
  └── apply infra/argocd/app-of-apps.yaml    (root Application)
        └── syncs infra/argocd/apps/*.yaml   (recurse)
              ├── wave 0: platform-* (sealed-secrets, postgres, redis, qdrant,
              │            keycloak, openfga, trigger)
              └── wave 1: companyos-services → infra/overlays/<env> (all 9 services)
```

Sync waves ensure platform dependencies (and the Sealed Secrets controller,
which must exist before any SealedSecret can be decrypted) come up before the
application services.

## Environments & promotion

Same bases, three overlays (`dev`, `staging`, `prod`). Promotion = a reviewed PR
changing the image tag in the target overlay's `kustomization.yaml`; Argo CD
detects the change and syncs. See `../docs/07-quality-gates.md §5` for release
gates.

## Secrets

**No plaintext secrets are ever committed.** Only `SealedSecret` CRs live in git
(`sealed-secrets/`), encrypted to the cluster's Sealed Secrets controller public
key. The controller decrypts them in-cluster into native `Secret`s that the
Deployments reference. See `sealed-secrets/README.md` for the sealing runbook.

## Authentication

Keycloak provides OIDC SSO. The realm is defined as code
(`platform/keycloak/realm-companyos.json`). The `web` Ingress and the `gateway`
validate OIDC tokens; the gateway is the authorization enforcement point
(OpenFGA). See `../docs/04-mcp-and-governance.md §8`.

## Local validation (run in CI)

```bash
# render every overlay and validate against the k8s schema
for env in dev staging prod; do
  kustomize build infra/overlays/$env | kubeconform -strict -summary
done
# lint manifests & IaC
kube-linter lint infra/
checkov -d infra/
```

These run as the `IaC scan` and `Manifest validity` hard gates in CI
(`../docs/07-quality-gates.md §1`). Tooling is not installed in this repo's
scaffolding container — validation happens in the pipeline.

## Prerequisites (cluster)

- CNCF-conformant Kubernetes (NFR-8), Argo CD installed.
- Bitnami Sealed Secrets controller (deployed as a platform app, but the
  controller's keypair must be bootstrapped first — see sealed-secrets runbook).
- An Ingress controller (NGINX or Gateway API) and cert-manager for TLS.
- StorageClass for Postgres/Qdrant PVCs; S3-compatible object storage.
