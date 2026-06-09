# PHASE-03 — Workflow Builder (MVP-3, UI half)

**Goal:** A React Flow visual builder where ops users compose workflows from the
core node set, with config panels and live validation, compiling to the
versioned Workflow DSL. (The durable **execution** engine is PHASE-04.)

**Exit criteria:** A user drags `Trigger → Brain Search → Agent → Condition →
Approval → Memory Write → Notify → End`, configures each, the canvas validates
against the DSL invariants, and saves a published, versioned workflow.

**Dominant tiers:** Sonnet (React Flow UI volume) + **Opus** (DSL compiler &
canvas↔DSL fidelity).

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T03.1 | React Flow canvas shell: nodes, edges, pan/zoom, palette | FR-6.1 | Sonnet | Unit (component): add/connect/delete nodes |
| T03.2 | Node components for all 13 node types with config panels | FR-6.2 | Sonnet | Unit per node; snapshot of config forms |
| T03.3 | Trigger config (manual/schedule/webhook/email/calendar/zoom/slack/github/jira) | FR-6.3 | Sonnet | Unit: each trigger validates required fields |
| T03.4 | **Canvas → DSL compiler** + **DSL → canvas** loader (round-trip fidelity) | FR-6.4 | **Opus** | Unit (TDD): round-trip equality; golden DSLs |
| T03.5 | Live validation surfacing DSL invariants (1–6) with inline errors | FR-6.1,6.4 | **Opus** | Unit: each invariant violation flagged |
| T03.6 | Reference pickers: tools/skills/agents resolve to registered+permitted entities | FR-6.2 | Sonnet | Integration: picker only lists permitted entities |
| T03.7 | Template-reference editor (`{{node.field}}`) with schema-aware autocomplete | DSL §6.6 | Sonnet | Unit: invalid refs flagged |
| T03.8 | Versioning UI: draft vs published, diff, rollback | FR-6.8 | Sonnet | e2e: publish v1, edit to v2, rollback |
| T03.9 | Save/publish API in `workflow-engine` (validate + persist version) | FR-6.4,6.8 | Sonnet | BDD: invalid DSL rejected; valid persisted |
| T03.10 | Per-workflow policy editors (permissions/memoryWrite/eval) | FR-6.9 | Sonnet | Unit: policy schema validation |
| T03.11 | Web a11y pass on builder (WCAG 2.1 AA) | NFR-10 | Sonnet | axe checks in e2e |
| T03.12 | Kustomize/Argo wiring for builder assets (served by `web`) | NFR-8 | Haiku | `kustomize build`; Argo healthy |

**Note:** No external effects execute yet — saving a workflow is inert until
PHASE-04. The DSL compiler (T03.4/T03.5) is the linchpin and Opus-owned.
