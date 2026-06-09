# ADR-0006 — MCP gateway as a policy-enforcing MCP server

**Status:** Accepted · 2026-06-09

## Context
External agents (Claude, Cursor, ChatGPT, Claude Code) and internal services all
need governed access to the brain and approved tools. We want one front door
where authn, authz, budgets, rate limits, and audit are enforced uniformly.

## Decision
Build the **gateway** as a policy-enforcing **MCP server** using the official
MCP SDK. It authenticates every client via OIDC, resolves a CompanyOS principal,
filters the advertised tool catalog per principal, checks OpenFGA on every
`tools/call`, applies budgets/rate-limits, and emits an audit record per
invocation. Study IBM ContextForge gateway patterns.

## Consequences
- Uniform enforcement; clients can't bypass governance.
- A single, well-tested choke point (contract-tested as an MCP server).
- The gateway is on the hot path → must be horizontally scalable and low-latency.
