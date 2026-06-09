# ADR-0007 — Monorepo (pnpm + Turborepo)

**Status:** Accepted · 2026-06-09

## Context
Frontend, gateway, and services share schemas, the DSL, auth helpers, telemetry,
and the test harness. Splitting into many repos would fragment these shared
contracts and slow cross-cutting changes.

## Decision
Single repository: `apps/*` (deployables) + `packages/*` (shared libs), managed
with **pnpm workspaces** + **Turborepo** for caching/affected builds. `infra/`
and `docs/` live alongside. CI builds only affected projects.

## Consequences
- Shared contracts (`packages/schemas`, `packages/dsl`) are imported, not copied.
- One PR can change a schema and all consumers atomically.
- Requires discipline on package boundaries; Turborepo enforces task graphs.
- Note: this `infra/`+`docs/` repo is the GitOps/spec home; application code
  lands in the same repo under `apps/`+`packages/` during the build phases.
