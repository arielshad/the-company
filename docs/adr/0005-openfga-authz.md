# ADR-0005 — OpenFGA as the single authorization decision point

**Status:** Accepted · 2026-06-09

## Context
The product's value depends on permission-aware access: agents and external MCP
clients must never reach data the requesting principal can't see. Scattering
authz across services guarantees drift and leaks.

## Decision
Use **OpenFGA** (relationship-based access control) as the **single** authz
decision point. The model lives as code in `infra/platform/openfga/model.fga`.
The gateway and every service call OpenFGA via `packages/auth`; no service makes
ad-hoc authz decisions. Brain retrieval additionally intersects OpenFGA results
with captured **source ACLs** (see `04-mcp-and-governance.md`).

## Consequences
- One model to reason about and audit; relations are testable in isolation.
- Every tool call and retrieval is checked; this is the core security guarantee.
- Adds a network hop per check; mitigated by caching and co-location.
- Authz changes are Opus-owned and `/security-review`'d.
