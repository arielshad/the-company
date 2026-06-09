# Implementation Status

This document maps the phased plan (`docs/phases/`) to the working,
test-covered code in this monorepo. Built with the TDD/BDD/e2e,
evidence-based methodology of `docs/05-development-methodology.md`.

## How to run

```bash
pnpm install
pnpm typecheck                      # node code (tsc --noEmit)
pnpm --filter @companyos/web exec tsc -p tsconfig.json --noEmit   # web (React) typecheck
pnpm test                           # 110 tests, 18 suites
pnpm test:coverage                  # enforces coverage gate (docs/07)

# Web UI (comprehensive React app with guided onboarding)
pnpm --filter @companyos/web dev    # Vite dev server on :5173
pnpm --filter @companyos/web build  # production bundle -> apps/web/dist
pnpm --filter @companyos/web start  # serves the built SPA + BFF on :3000
```

## Web UI (apps/web)

A full single-page app (Vite + React + React Flow) that drives the **real**
in-browser platform — not mocks. `src/app/lib/platform.ts` instantiates the
actual services (auth, brain, governance, workflow engine, gateway, agent &
skill registries, connectors), seeds a demo org, and the UI operates them live.

- **Guided onboarding** (`onboarding/Onboarding.tsx`): a 7-step tour ending in a
  *live* run of the flagship workflow — trigger → eval gate → **approval
  pause** → approve → memory write → Jira task → Slack — inside the wizard.
- **Pages**: Dashboard (getting-started checklist + activity), Company Brain
  (permission-aware search with provenance), Connectors, Agents (CRUD, budgets,
  org chart, live task runs), Workflows (React Flow builder: palette, validate
  against DSL invariants, run), Skills (eval-gated promotion), Governance
  (approvals, audit log, budgets), Settings.
- Served by the existing Node BFF (`src/server/serve.ts`) on :3000 (static SPA +
  `/api/*` + `/healthz`/`/readyz`), matching the `infra/base/web` Deployment.
- Tests: `src/app/web.test.tsx` (onboarding flow + page render via
  Testing Library + jsdom).

All tests run offline & deterministically — LLM agents, model judges, and
external backends (Postgres/OpenFGA/Qdrant/providers) are behind interfaces with
in-memory implementations, so the whole platform is exercisable in CI. The
production seams (ADR-0003/0004/0005) swap those implementations without
touching business logic.

## Phase → code → proof

| Phase | What was built | Package(s) | Tests |
| --- | --- | --- | --- |
| **00 Foundation** | Monorepo (pnpm+vitest+tsc), shared contracts: Zod models, Workflow DSL + validator (invariants 1–6) + canvas↔DSL compiler, ReBAC authz engine + OIDC principal + source-ACL filter, logger + append-only tamper-evident audit + cost/budget metering, fixtures | `packages/schemas`, `packages/dsl`, `packages/auth`, `packages/telemetry`, `packages/testing` | 37 |
| **01 Agent registry** | CRUD, agent templates, org chart with cycle prevention, manual task runs with budget metering & hard-stop | `apps/agent-registry` | 6 |
| **02 Company brain** | Ingestion (idempotent), hybrid retrieval (vector+keyword+recency), **permission-aware search** (OpenFGA ∩ source-ACL), typed memory write + policy + approval routing, supersede/expire, lineage | `apps/brain` | 10 |
| **03 Builder (UI shell)** | Node palette, canvas→DSL compile+validate BFF, health probes, HTTP host | `apps/web`, `packages/dsl` | 5 |
| **04 Workflow engine** | Durable-style executor for all node types, branching, bounded loops, **pause/resume human approvals**, eval gating, run inspector log; **flagship Zoom→brain e2e** | `apps/workflow-engine`, `e2e` | 6 + 2 |
| **05 Skill registry** | Package validation, register/sync + changelog, role filtering, **eval-gated promotion** (draft→active) | `apps/skill-registry` | 8 |
| **06 Connectors** | Connector SDK + Zoom connector (transcript→ingest+trigger with provenance/ACL), health tracking | `apps/connectors` | 4 |
| **07 Hardening** | Interface seams for durable backend (ADR-0003) & vector store (ADR-0004); audit integrity digest; tenancy via `orgId` scoping; infra overlays + NetworkPolicies + sealed secrets (`infra/`) | cross-cutting + `infra/` | (infra CI job) |
| **08 Governance & evals** | Evaluators (source_coverage/factuality/policy/tone/hallucination) + suite gating, authorize+audit on every action, approvals (decide/timeout/escalate), budget enforcement, eval gate | `apps/eval-service`, `apps/governance` | 7 + 7 |

**Total: 110 tests across 18 suites, all green** (incl. the web UI and the
durable SQLite backends below). Coverage exceeds the gate in `docs/07`
(lines ~94%, branches ~92%, functions ~88%).

## Flagship end-to-end proof

`e2e/zoom-to-brain.spec.ts` drives the whole platform (docs/01 §6):

```
Zoom transcript → connector → workflow.trigger (via MCP gateway, as the ops agent)
 → clean → extract (agent, budget-metered) → brain_search
 → eval gate (block) → condition (customer-sensitive) → approval (PAUSE)
 → human approves → RESUME → memory_write → Jira task → Slack notify → end
 → brain.search via MCP returns the new memory WITH provenance
 → full immutable audit trail asserted
```

It also asserts the negative path: when the eval gate fails, the run is blocked
and **no external effects** occur. Evidence artifacts (run inspector, audit log,
integrity digest) are written to `e2e/artifacts/` and uploaded by CI.

## Durable persistence (real backends, verifiable locally)

Two of the most compliance-critical stores now have **durable SQLite-backed
implementations** behind their existing interfaces, using the built-in
`node:sqlite` (no native deps, no Docker). The ReBAC algorithm and audit digest
are shared with the in-memory versions, so semantics are identical and proven by
the same contract tests; new tests prove the data survives a process restart.

- **Authz store**: `SqliteAuthz` (`@companyos/auth/sqlite`) — persists relation
  tuples; reuses `runCheck`/`AbstractAuthz`, so it satisfies the same ReBAC
  contract as `InMemoryAuthz`. ADR-0005.
- **Audit log**: `SqliteAudit` (`@companyos/telemetry/sqlite`) — append-only
  (no update/delete API), tamper-evident rolling digest, durable across reopen.
  FR-8.4 / NFR-7.
- Proven together in `apps/governance/src/durable.test.ts`: the *same*
  `GovernanceService` runs on both SQLite backends and its audit trail survives a
  simulated restart with the digest chain intact.
- These are node-only (loaded via `createRequire`), so the browser bundle and
  the in-memory test path are unaffected.

## What is intentionally interface-only (production swaps)

These have working in-memory implementations behind the interface used in tests;
the production adapter is the remaining work, isolated by design:

- **Durable execution**: Trigger.dev/Temporal adapter behind `WorkflowEngine`
  (logic, retries, pause/resume modeled in-process). ADR-0003.
- **Vector store / graph**: pgvector/Qdrant/Graphiti behind `BrainService`
  retrieval (bag-of-words embedding used offline). ADR-0004.
- **Distributed authz**: OpenFGA behind `AuthzEngine` for multi-node deploys
  (would make `check` async); the SQLite store above covers single-node
  durability today. ADR-0005.
- **LLM agents & judges**: provider clients behind `AgentHandler`/eval
  `Evaluator` (deterministic stand-ins). ADR-0002.
- **MCP transport**: `@modelcontextprotocol/sdk` wraps `McpGateway`’s typed
  tools/list + tools/call. ADR-0006.
- **web**: React Flow canvas in the browser calls the implemented BFF
  (palette + compile/validate). PHASE-03.
