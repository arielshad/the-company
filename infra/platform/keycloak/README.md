# Keycloak — Identity & SSO

Keycloak provides OIDC SSO for CompanyOS (FR-1.1, NFR-1). The realm is defined
as code in `realm-companyos.json` and imported on startup / reconciled by a
Job; see `docs/04-mcp-and-governance.md §8`.

## Files
- `realm-companyos.json` — realm-as-code: clients, roles, groups, mappers.
- `kustomization.yaml`, `statefulset.yaml`, `service.yaml`, `configmap.yaml`
  (realm import), referenced by the Argo `platform-keycloak` Application.

## Clients
| Client | Type | Use |
| --- | --- | --- |
| `companyos-web` | public (PKCE) | Frontend login |
| `companyos-gateway` | confidential | MCP gateway / BFF, validates tokens |
| `companyos-services` | confidential (client-credentials) | Service-to-service (FR-1.5) |

## Roles → CompanyOS → OpenFGA
Realm roles (`owner/admin/builder/member/auditor/agent`) appear in the
`realm_access.roles` claim. On login/sync, CompanyOS mirrors roles + group
membership into **OpenFGA relations** (e.g. `org:#admin`, `team:engineering#member`)
so authorization is enforced uniformly by OpenFGA (ADR-0005).

## Secrets
Client secrets and the admin password are **never** committed. They are
delivered via the `keycloak-client-secrets` SealedSecret (see
`infra/sealed-secrets/`). The realm JSON uses `REPLACED_BY_SEALED_SECRET`
placeholders that the import process overlays from the decrypted Secret.

## Connector OAuth
Per-connector provider OAuth credentials (Notion, Drive, GitHub, Slack, Gmail,
Calendar, Zoom, Jira) are **not** in Keycloak — they are per-connector sealed
secrets with least-privilege provider scopes (FR-2.3).
