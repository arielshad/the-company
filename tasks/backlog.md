# Master Backlog

The authoritative task list. Per-phase detail (FR mapping, acceptance, test
strategy) lives in `docs/phases/PHASE-0x-*.md`; this file is the consolidated
index, tier summary, and execution order. Tier legend: **O**=Opus,
**S**=Sonnet, **H**=Haiku.

## Execution order & dependencies

```
PHASE-00 (foundation)  ──▶ PHASE-01 (agent registry)
        │                      │
        └──▶ PHASE-02 (brain) ─┼──▶ PHASE-03 (builder UI)
                               │            │
                               └────────────┴──▶ PHASE-04 (workflow engine + flagship e2e)
                                                          │
                          PHASE-05 (skills) ◀─────────────┤
                          PHASE-06 (connectors) ◀─────────┘
                                                          │
                                              PHASE-07 (hardening)
                                                          │
                                              PHASE-08 (governance/evals)
```

PHASE-02 can start in parallel with PHASE-01 once PHASE-00 lands (`packages/*`,
gateway, CI, Argo). PHASE-03 needs the DSL (`packages/dsl`, PHASE-00). PHASE-04
needs PHASE-02 + PHASE-03. PHASE-05/06 need PHASE-04. PHASE-07/08 are last.

## Tier summary (by phase)

| Phase | Tasks | Opus | Sonnet | Haiku | Theme |
| --- | --- | --- | --- | --- | --- |
| PHASE-00 Foundation | 17 | 6 | 8 | 3 | Patterns, authz, CI, GitOps |
| PHASE-01 Agent registry | 13 | 2 | 9 | 2 | CRUD + UI + budgets |
| PHASE-02 Brain | 17 | 9 | 7 | 1 | Core IP, security-sensitive |
| PHASE-03 Builder UI | 12 | 2 | 9 | 1 | React Flow + DSL compiler |
| PHASE-04 Workflow engine | 17 | 8 | 9 | 0 | Durability, flagship e2e |
| PHASE-05 Skill registry | 11 | 1 | 8 | 2 | Sync + promotion gate |
| PHASE-06 Connectors | 9 | 1 | 5 | 3 | Repetitive integration |
| PHASE-07 Hardening | 13 | 7 | 6 | 0 | Reliability + security |
| PHASE-08 Governance/evals | 9 | 4 | 4 | 1 | Eval framework + dashboards |
| **Total** | **118** | **40** | **65** | **13** | |

Roughly **34% Opus / 55% Sonnet / 11% Haiku** — Opus concentrated in
architecture, security, the DSL, the workflow engine core, and the eval
framework; Sonnet carries feature/UI/integration volume; Haiku handles
scaffolding, config, and manifests. Per `06-subagent-strategy.md`, anything
touching authz, secrets, the DSL, data models, or the engine core is Opus or
Opus-reviewed regardless of size.

## How to pick up a task

1. Confirm Definition of Ready (`05-development-methodology.md §6`).
2. Use the assigned tier; escalate per `06-subagent-strategy.md §4` if it no
   longer fits.
3. TDD red→green; add BDD for the FR; e2e if user-facing.
4. Attach the evidence bundle to the PR (`05 §5`); add a traceability row.
5. Update manifests if the service shape changed; ensure `kustomize build` +
   kubeconform pass.
6. Pass all hard gates (`07-quality-gates.md`) before merge.

## Parallelization notes for the orchestrator

- Run independent Sonnet feature tasks and Haiku scaffolds concurrently.
- Batch Haiku config/manifest tasks (T00.10/12, T01.12, T05.11, T06.7/9, T08.9).
- Keep Opus on the critical path: T00.2/3/4 (schemas/DSL/auth) unblock the most
  downstream work — do them first.
- Connector tasks (PHASE-06) are embarrassingly parallel once the SDK (T06.1,
  Opus) exists — fan out to Sonnet.
