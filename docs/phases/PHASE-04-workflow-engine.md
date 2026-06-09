# PHASE-04 — Workflow Engine & Flagship Scenario (MVP-3, execution half)

**Goal:** Durable, resumable, idempotent execution of the Workflow DSL with
agents, tools, conditions, loops, human approvals, memory writes, tasks, evals,
and notifications — then prove it end-to-end with the **Zoom-transcript →
company-brain** flagship scenario.

**Exit criteria:** The flagship scenario runs end-to-end (e2e): Zoom transcript
triggers extraction, approval gates low-confidence, memory is written with
provenance, a Jira task is created, Slack is notified, and the new context is
retrievable via MCP — with a full run-inspector record and audit trail.

**Dominant tiers:** **Opus** (engine core, durability, correctness) + Sonnet
(individual node executors, notify/task integrations).

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T04.1 | Executor core on Trigger.dev: load DSL version, schedule durable run, dedupe keys | FR-6.5, NFR-3 | **Opus** | Integration: run survives worker restart; at-least-once + dedupe |
| T04.2 | Node executor framework: idempotent steps, per-node IO capture, retries | FR-6.5,6.7 | **Opus** | Unit (TDD): retry/idempotency; integration: IO recorded |
| T04.3 | `agent` node via VoltAgent: goal+tools+memory+model+budget; supervisor coordination | FR-6.2, FR-4.3 | **Opus** | Integration: agent run metered + audited |
| T04.4 | `brain_search` node | FR-6.2 | Sonnet | Integration: returns cited results |
| T04.5 | `tool`/MCP node via gateway (authz+budget+audit) | FR-6.2,7.* | Sonnet | Contract + BDD authz |
| T04.6 | `condition` node (expr eval over upstream outputs) | FR-6.2 | Sonnet | Unit (TDD): branch selection |
| T04.7 | `loop` node (retry / until-confidence / iterate list) with bounds | FR-6.2 | **Opus** | Unit: termination bounds; no runaway |
| T04.8 | `approval` node: pause→notify→resume; durable; timeout policy | FR-6.6,8.1 | **Opus** | BDD: pause, approve, resume; timeout escalates |
| T04.9 | `memory_write` node honoring memoryWritePolicy + approval-below-confidence | FR-6.2,8.1 | **Opus** | BDD: low-confidence routes to approval |
| T04.10 | `task` node: Jira/Linear create/assign/follow-up; CRM/doc update | FR-9.2 | Sonnet | Contract vs Jira/Linear mocks |
| T04.11 | `eval` node + gate (block external effects on fail) | FR-8.2,8.3 | **Opus** | BDD: failing eval blocks downstream external node |
| T04.12 | `notify` node: Slack/email/Linear/Jira/Notion | FR-9.1 | Sonnet | Contract vs mocks |
| T04.13 | Run inspector API + UI: per-node IO/timing/cost/logs/replay | FR-6.7 | Sonnet | e2e: inspector shows full run; replay works |
| T04.14 | Trigger plumbing: webhook/schedule/email/calendar/zoom/slack/github/jira → run start | FR-6.3 | Sonnet | Integration: each trigger starts a run |
| T04.15 | **Flagship e2e**: zoom-to-brain full scenario with artifacts | §05, FR-* | **Opus** (author) | e2e: passes; artifacts uploaded |
| T04.16 | Kustomize/Argo for `workflow-engine` + Trigger.dev platform; worker HPA | NFR-5,8 | Sonnet | `kustomize build`; Argo healthy; scale test |
| T04.17 | Idempotency & exactly-once-effect review across external nodes | NFR-3 | **Opus** | Integration: duplicate trigger → single effect |

**Risk:** Durability and exactly-once external effects are the hardest
correctness problems in the product — engine core, loop bounds, approval
resume, and idempotency (T04.1/2/7/8/17) are Opus-owned and `/security-review`'d
where they touch external sends.
