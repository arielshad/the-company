# Architecture Decision Records

Short, dated records of significant decisions. Format: Context → Decision →
Consequences. New decisions append; superseded ones are marked, not deleted.

| ADR | Decision | Status |
| --- | --- | --- |
| 0001 | TypeScript/Node everywhere | Accepted |
| 0002 | VoltAgent as agent runtime (LangGraph optional) | Accepted |
| 0003 | Trigger.dev for MVP durability, Temporal at scale | Accepted (MVP refined by 0008: Postgres-native) |
| 0004 | pgvector primary, Qdrant optional; Graphiti for graph | Accepted (MVP refined by 0008: pgvector-only) |
| 0005 | OpenFGA as the single authorization decision point | Accepted |
| 0006 | MCP gateway as policy-enforcing MCP server | Accepted |
| 0007 | Monorepo (pnpm + Turborepo) | Accepted |
| 0008 | Modular monolith (`core`) split-ready; shep-infra is the platform SoT, the-company ships workloads | Accepted |
