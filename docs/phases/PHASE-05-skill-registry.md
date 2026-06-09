# PHASE-05 — Skill Registry (MVP-4)

**Goal:** Reusable, versioned, portable company skills sourced from Notion (MVP)
and GitHub packages (later), validated and synced into the backend, runnable
directly or as workflow nodes, and gated by evals before activation.

**Exit criteria:** A skill defined in a Notion database (or GitHub package) is
synced, validated against its schemas, versioned, runnable via `skill.run` over
MCP, and cannot be promoted to `active` until its `evals.yaml` passes.

**Dominant tiers:** Sonnet (sync engine, run integration) + Haiku (package
scaffolds) + Opus for the promotion-gate correctness.

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T05.1 | `skill-registry` service + schema (skills, versions, sources) with RLS | FR-5.1,5.3 | Sonnet | Integration: CRUD + versioning |
| T05.2 | Skill package format + validator (`SKILL.md`/`workflow.yaml`/`tools.json`/`examples.md`/`evals.yaml`) | FR-5.1 | Sonnet | Unit (TDD): malformed package rejected |
| T05.3 | Department namespaces + allowedRoles enforcement | FR-5.5,5.3 | Sonnet | BDD: role-gated skill visibility |
| T05.4 | Notion source sync: pull→validate→register/version→diff+changelog | FR-5.2,5.4 | Sonnet | Integration vs Notion mock; idempotent sync |
| T05.5 | GitHub-backed package sync (semver, signed?) | FR-5.2 | Sonnet | Integration vs GitHub mock |
| T05.6 | `skill.run`: direct run + as workflow node; resolves required tools | FR-5.6 | Sonnet | Contract (MCP) + BDD run |
| T05.7 | **Promotion gate**: draft→active requires passing eval suite | FR-5.7,8.3 | **Opus** | BDD: failing evals block promotion; passing promotes |
| T05.8 | Skill templates/scaffolds per department (sales/eng/support/...) | FR-5.5 | Haiku | Unit: scaffolds validate |
| T05.9 | Web: skill catalog, detail, version history, run | FR-5.* | Sonnet | e2e: browse → run skill |
| T05.10 | Gateway: `skill.run` authz + budget + audit | FR-7.* | Sonnet | Contract + BDD authz |
| T05.11 | Kustomize/Argo for `skill-registry` | NFR-8 | Haiku | `kustomize build`; Argo healthy |

**Seed content:** ship example skills (e.g. `sales/qualify-lead`,
`engineering/investigate-production-incident`) as fixtures to exercise the
registry and as docs-by-example.
