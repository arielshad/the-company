# Sealed Secrets

CompanyOS uses **Bitnami Sealed Secrets**. Plaintext secrets **never** enter
git. Only `SealedSecret` custom resources — encrypted with the cluster
controller's public key — are committed here. The controller decrypts them
in-cluster into native `Secret`s that Deployments reference (NFR-1).

## Why
- Git is the source of truth (GitOps), but secrets can't be plaintext in git.
- A `SealedSecret` can only be decrypted by the controller in the target
  cluster — safe to commit, push, and review.

## Bootstrap (once per cluster)
The Sealed Secrets controller must exist **before** any SealedSecret syncs (it
is Argo sync-wave 0, alongside the controller install):

```bash
# install controller (also managed as platform/sealed-secrets Argo app)
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/latest/download/controller.yaml
# fetch the public cert used to seal (commit-safe)
kubeseal --fetch-cert > infra/sealed-secrets/pub-cert.pem
```

## Sealing a secret (developer workflow)
Never commit the plaintext. Create it locally, seal it, commit only the sealed
output, then delete the plaintext.

```bash
# 1. create plaintext secret locally (NOT committed)
kubectl create secret generic gateway-secrets \
  --namespace companyos-system \
  --from-literal=OIDC_CLIENT_SECRET=... \
  --from-literal=DATABASE_URL=... \
  --dry-run=client -o yaml > /tmp/gateway-secrets.yaml

# 2. seal it to the cluster's public cert
kubeseal --format yaml --cert infra/sealed-secrets/pub-cert.pem \
  < /tmp/gateway-secrets.yaml \
  > infra/sealed-secrets/gateway-sealedsecret.yaml

# 3. commit ONLY the sealed file; destroy the plaintext
rm /tmp/gateway-secrets.yaml
```

## Naming convention
`<svc>-sealedsecret.yaml` → produces Secret `<svc>-secrets` in
`companyos-system`. Platform secrets: `keycloak-client-secrets`,
`openfga-secrets`, `postgres-secrets`, per-connector `connector-<name>-secrets`.

## Secrets inventory (what must be sealed before deploy)
| Secret | Consumed by | Keys (examples) |
| --- | --- | --- |
| `gateway-secrets` | gateway | OIDC_CLIENT_SECRET, DATABASE_URL, REDIS_URL |
| `keycloak-client-secrets` | keycloak import, gateway | gateway/services client secrets, admin pw |
| `openfga-secrets` | openfga, services | OPENFGA_API_TOKEN, store id |
| `postgres-secrets` | postgres, all services | POSTGRES_PASSWORD, per-db creds |
| `brain-secrets` | brain | embedding/provider API keys, S3 creds |
| `connector-<name>-secrets` | connectors | per-provider OAuth client id/secret (least-priv scopes) |
| `provider-secrets` | agent-registry, eval-service | Anthropic/OpenAI/Google API keys |

## Guardrails
- `gitleaks` runs in CI as a hard gate — a committed plaintext secret fails the
  build (`docs/07-quality-gates.md §1`).
- Key rotation: re-seal against a rotated controller key; the controller
  supports key renewal without downtime. Connector tokens rotate per FR-2.3.
- `pub-cert.pem` is safe to commit; the controller **private** key never leaves
  the cluster and is itself backed up out-of-band (DR runbook, T07.6).
