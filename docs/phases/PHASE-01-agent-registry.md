# PHASE-01 — Agent Registry (MVP-1)

**Goal:** Manage agents like employees: create agents with roles/goals/tools/
budgets/managers, visualize the org chart, run a manual task, and track output
+ cost + tool calls — all governed and audited.

**Exit criteria:** An admin creates an agent, assigns a role/tools/budget/manager,
runs a manual task, and sees the output, cost, and an audit trail; budget caps
are enforced.

**Dominant tiers:** Sonnet (CRUD + UI), Haiku (scaffolds), Opus for budget
enforcement correctness.

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T01.1 | `agent-registry` service skeleton + DB migrations (agents, org chart) with RLS by org | FR-4.1, NFR-2 | Sonnet | Integration: CRUD + RLS isolation |
| T01.2 | Agent CRUD API (validated by `packages/schemas`) | FR-4.1 | Sonnet | BDD: create/read/update/archive agent |
| T01.3 | Org chart: manager links, cycle prevention, reporting tree query | FR-4.2 | Sonnet | Unit (TDD): cycle rejected; tree built correctly |
| T01.4 | Budget model + metered provider client (tokens→USD), soft-warn/hard-stop | FR-4.3, NFR-9 | **Opus** | Unit: metering math; BDD: hard-stop at cap emits `budget.exceeded` |
| T01.5 | Agent templates (CEO/PM/Engineer/Researcher/Sales/Support) | FR-4.4 | Haiku | Unit: templates validate against schema |
| T01.6 | Manual task runner: invoke agent, capture output/cost/tool-calls/trace | FR-4.5 | Sonnet | Integration: run records persisted with cost |
| T01.7 | OpenFGA relations for agents (org/team membership, who can run/edit) | FR-1.4 | **Opus** | Integration: allow/deny per relation |
| T01.8 | Gateway: expose agent run + agent tool catalog filtered per principal | FR-7.2,7.3 | Sonnet | Contract: MCP tool contract; BDD authz |
| T01.9 | Web: agent list/create/edit forms + template picker | FR-4.1,4.4 | Sonnet | e2e: create agent via UI |
| T01.10 | Web: org chart visualization | FR-4.2 | Sonnet | e2e: org chart renders reporting lines |
| T01.11 | Web: per-agent activity feed (runs, cost, audit links) | FR-4.6 | Sonnet | e2e: feed shows a completed run |
| T01.12 | Kustomize base + Argo Application for `agent-registry`; dev overlay | NFR-8 | Haiku | `kustomize build`; Argo healthy |
| T01.13 | Audit wiring for agent lifecycle + runs | FR-8.4 | Sonnet | Integration: audit records on create/run |

**Notes:** Evaluation scores (FR-4.6) are stubbed here and completed in PHASE-08.
Budget correctness is Opus-owned (NFR-9, real money).
