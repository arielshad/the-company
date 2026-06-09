# OpenFGA — Authorization

OpenFGA is the single authorization decision point (ADR-0005). The model is
defined as code in `model.fga` and is the only place authz logic lives; the
gateway and every service call OpenFGA via `packages/auth`.

## Files
- `model.fga` — the authorization model (ReBAC), versioned and reviewed.
- `kustomization.yaml`, `deployment.yaml`, `service.yaml` — OpenFGA runtime
  (referenced by the Argo `platform-openfga` Application).

## Applying the model
The model is **not** applied by Kustomize; it is loaded into the running OpenFGA
store via a one-shot Job (or CI step) on change:

```bash
fga model write --store-id "$STORE_ID" --file model.fga
```

A new model write creates a new immutable `authorization_model_id`; services
pin the id via config so a model change is an explicit, reviewed rollout.

## Testing
Model changes ship with `.fga.yaml` test tuples (assertions) run in CI:

```bash
fga model test --tests model.tests.fga.yaml
```

Authz changes are **Opus-owned** and require `/security-review` (see
`docs/06-subagent-strategy.md §5`).
