# ADR-0002 — VoltAgent as agent runtime (LangGraph optional)

**Status:** Accepted · 2026-06-09

## Context
We need an agent runtime with memory, tools, multi-step workflows, multiple
providers, and supervisor-style multi-agent coordination. Candidates: VoltAgent
(TS), LangGraph (mature graph model, Python-first), AutoGen, CrewAI.

## Decision
Use **VoltAgent** for the `agent` node and supervisor coordination (TS-native,
fits ADR-0001). Keep **LangGraph** as an option behind the DSL compiler
boundary: the workflow engine executes our DSL, so the underlying runtime can be
swapped per node type without changing workflows.

## Consequences
- Agent execution stays in-process with the rest of the TS stack.
- The DSL (not the runtime) is the contract, so runtime choice is reversible.
- Provider abstraction lives in the budget-aware client (ADR-0003 adjacent).
