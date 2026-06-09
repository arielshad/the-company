# 06 — Subagent Strategy (Opus · Sonnet · Haiku)

Every task in `tasks/backlog.md` is tagged with a model tier. This document
defines **how to choose the tier**, the **operating rules** per tier, and the
**escalation/verification** protocol. The goal: spend the most capable (and
expensive) reasoning where it changes outcomes, and let cheaper tiers do the
high-volume, well-specified work — without compromising the evidence contract.

---

## 1. Tier definitions

| Tier | Model | Use for | Don't use for |
| --- | --- | --- | --- |
| **Opus** (`claude-opus-4-8`) | Deep reasoning, cross-cutting design, ambiguity | Architecture, security/threat modeling, authz model design, DSL & data-model design, workflow-engine core, eval framework design, MCP protocol design, ADRs, tricky debugging, multi-service refactors, reviewing other tiers' high-risk output | Boilerplate, formatting, routine CRUD, config generation |
| **Sonnet** (`claude-sonnet-4-6`) | The bulk of implementation | Feature code, CRUD APIs, React components, connectors, integration & BDD tests, Kustomize manifests, CI pipelines, refactors within one service | Novel architecture decisions, security-critical authz logic without Opus review |
| **Haiku** (`claude-haiku-4-5`) | High-volume, low-ambiguity, mechanical | Scaffolding, boilerplate, config/YAML from a template, fixtures/seed data, type/DTO generation from schemas, docs formatting, dependency bumps, codemods, label/i18n strings | Anything requiring design judgment, security logic, or interpreting ambiguous requirements |

> The orchestrator (an Opus-tier planner) assigns tasks, but the rule of thumb
> is: **judgment & blast-radius → Opus; build → Sonnet; mechanical volume → Haiku.**

---

## 2. Decision rubric

Assign a tier by scoring the task on four axes:

| Axis | Low → Haiku | Medium → Sonnet | High → Opus |
| --- | --- | --- | --- |
| **Ambiguity** | Fully specified | Some interpretation | Requirements/trade-offs open |
| **Blast radius** | One file/config | One service | Cross-service / security / data model |
| **Novelty** | Template exists | Known pattern | New abstraction/decision |
| **Reversibility** | Trivially reversible | Reversible with effort | Hard to reverse (schema, authz, DSL) |

Highest axis wins. Any task touching **authz, secrets, the DSL, data models, or
the workflow engine core** is **Opus or Opus-reviewed**, regardless of size.

---

## 3. Operating rules (all tiers)

1. **Same evidence contract.** Every tier follows `05-development-methodology.md`
   (TDD red→green, BDD, e2e where applicable). No tier is exempt.
2. **Stay in lane.** A subagent works only the assigned task scope; cross-cutting
   changes are escalated, not improvised.
3. **Tests first, always.** Even Haiku scaffolding tasks that produce code ship
   with the relevant test or a `// TODO(test): TASK-ID` only if the task is
   pure non-code config.
4. **Deterministic outputs.** Haiku/Sonnet generate from the canonical schemas in
   `packages/schemas` and the DSL in `packages/dsl` — never hand-invent shapes.

---

## 4. Escalation protocol

A subagent **must escalate to the next tier up** when it hits any of:

- A requirement is ambiguous or under-specified.
- The change would alter an interface, schema, authz relation, or the DSL.
- A test reveals a design problem rather than an implementation bug.
- The fix would exceed the task's scope or require touching another service.

Escalation = stop, summarize findings + the specific decision needed, hand to
Opus (or ask the human via `AskUserQuestion` if it's a product decision).

---

## 5. Verification & review matrix

| Work produced by | Reviewed by | Gate |
| --- | --- | --- |
| Haiku | Sonnet (or automated checks if purely mechanical) | CI gates |
| Sonnet | Sonnet peer for normal; **Opus** for security/authz/DSL/data-model touches | CI gates + review |
| Opus | Opus peer or human for highest-risk (authz model, threat model, DSL) | CI gates + human sign-off on security items |

The `/code-review` and `/security-review` skills run on every PR; security-review
is **mandatory** on PRs touching `auth`, `governance`, `gateway`, secrets, or
IaC network policy.

---

## 6. Phase-level tier mix (guidance)

| Phase | Dominant tier | Why |
| --- | --- | --- |
| PHASE-00 Foundation | Sonnet build + **Opus** for authz/secret/CI design | Sets cross-cutting patterns |
| PHASE-01 Agent registry | Sonnet, Haiku for scaffolds | Mostly CRUD + UI |
| PHASE-02 Brain | **Opus** (retrieval, permission filter, memory model) + Sonnet ingestion | Core IP + security-sensitive |
| PHASE-03 Builder | Sonnet (React Flow), **Opus** for DSL compiler | UI volume + DSL judgment |
| PHASE-04 Workflow engine | **Opus** core + Sonnet nodes | Durability/correctness critical |
| PHASE-05 Skill registry | Sonnet + Haiku (package scaffolds) | Pattern-driven |
| PHASE-06 Connectors | Sonnet (each connector) + Haiku (config) | Repetitive integration work |
| PHASE-07 Hardening (Temporal, mesh, perf) | **Opus** design + Sonnet impl | Reliability/security |
| PHASE-08 Governance depth & evals | **Opus** (eval design) + Sonnet runners | Correctness of gates |

> Per-task tiers are authoritative in `tasks/backlog.md`; this table is the
> planning-level expectation.

---

## 7. Cost discipline

- Treat model spend like the agent budgets the product itself enforces: prefer
  the lowest tier that can do the task to its evidence bar.
- Batch mechanical Haiku tasks; run independent tasks in parallel.
- Opus time is reserved for the ~20% of decisions that determine the other 80%.
