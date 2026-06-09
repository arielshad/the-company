# ADR-0001 — TypeScript/Node everywhere

**Status:** Accepted · 2026-06-09

## Context
Team background is Node/TypeScript. VoltAgent (chosen runtime) is TS-first. A
single language reduces context-switching, lets us share schemas (`packages/
schemas`) and the DSL (`packages/dsl`) across frontend, gateway, and services,
and simplifies the test harness and CI.

## Decision
All application code is TypeScript on Node. Python is used only if a specific
brain/eval component has no acceptable TS option, and then it is isolated behind
an HTTP/MCP boundary with its own contract tests — never imported into TS code.

## Consequences
- One toolchain (pnpm + Turborepo + Vitest), shared types end-to-end.
- Some best-in-class ML/RAG libraries are Python; mitigated by the API boundary.
- Reviewers can reason about the whole stack in one language.
