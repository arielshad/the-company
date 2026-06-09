# 07 — Quality Gates & Definition of Done

These are the **enforced** gates. CI blocks merge if any hard gate is red. They
apply to every task and every tier.

## 1. Hard gates (block merge)

| Gate | Threshold | Enforced by |
| --- | --- | --- |
| Lint | 0 errors | ESLint + Prettier check |
| Typecheck | 0 errors | `tsc --noEmit` |
| Unit tests | 100% pass | Vitest |
| Integration tests | 100% pass | Vitest + Testcontainers |
| BDD scenarios (touched FRs) | 100% pass | Cucumber.js |
| Contract tests (touched boundaries) | verified | Pact |
| Coverage | ≥ 80% lines / ≥ 75% branches, **no decrease** | Vitest coverage |
| Build | all changed apps build + image builds | Turborepo + Docker |
| Secret scan | 0 findings | gitleaks |
| Dependency audit | 0 high/critical | osv-scanner / npm audit |
| IaC scan | 0 high (manifests/policies) | kubeconform + kube-linter + checkov |
| Manifest validity | all Kustomize builds render & validate | `kustomize build` + kubeconform |

## 2. Conditional gates

| Gate | When | Threshold |
| --- | --- | --- |
| e2e (Playwright) | user-facing change or `run-e2e` label or merge to main | flagship journeys pass + artifacts uploaded |
| Perf (k6) | task tagged NFR-4 | meets p95 budget |
| Eval suite | skill promotion / workflow with `evalPolicy` | meets per-eval thresholds |
| `/security-review` | PR touches `auth`/`governance`/`gateway`/secrets/network policy | no unresolved high findings |

## 3. Definition of Done checklist (per task)

```
[ ] Linked to FR-/NFR- and a tasks/backlog.md task id
[ ] Red test captured, then green (evidence in PR)
[ ] BDD scenario(s) for the FR pass
[ ] e2e passes with artifacts (if user-facing)
[ ] Coverage ≥ gate, no decrease
[ ] Lint / typecheck / format clean
[ ] Contracts verified (if boundary touched)
[ ] Security & IaC scans clean
[ ] Manifests updated (if service shape changed) and `kustomize build` passes
[ ] Docs / ADR updated; traceability-matrix row added
[ ] Reviewed per 06-subagent-strategy.md review matrix
```

## 4. Coverage philosophy

Coverage is a floor, not a goal. We do not write tests to hit a number; we hit
the number because we wrote the tests first (TDD). Branch coverage matters most
on `packages/dsl`, `packages/auth`, `governance`, and the workflow engine — set
these to ≥ 90% branches in their package configs.

## 5. Release gates (per environment)

| Env | Gate to promote |
| --- | --- |
| dev | all PR gates green on main |
| staging | dev healthy 24h + smoke e2e green + no open sev-1 |
| prod | staging green 24h + change record + on-call ack + rollback verified |

Promotion is a PR to the env overlay changing image tags; Argo CD syncs.
