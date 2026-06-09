# ADR-0003 — Trigger.dev for MVP, Temporal at scale

**Status:** Accepted · 2026-06-09

## Context
Workflows are long-running, must survive restarts, retry idempotently, and pause
for human approval. Trigger.dev gives fast TS-native durable jobs; Temporal is
the gold standard for durable execution but heavier to operate.

## Decision
Ship the MVP on **Trigger.dev**. Put all execution behind an **executor
interface** in `workflow-engine` so a **Temporal** backend can be added in
PHASE-07 without touching the DSL or node executors. Heavy/critical workflows
migrate to Temporal; light jobs may stay on Trigger.dev.

## Consequences
- Faster MVP, lower initial ops burden.
- A parity test suite (T07.1) guarantees identical DSL behavior across backends.
- Migration risk is contained to the executor adapter.
