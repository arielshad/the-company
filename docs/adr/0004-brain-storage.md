# ADR-0004 — pgvector primary, Qdrant optional, Graphiti for graph

**Status:** Accepted · 2026-06-09

## Context
The brain needs vector search and a temporal entity graph. Options: pgvector
(in Postgres we already run), dedicated vector DBs (Qdrant), and graph/memory
layers (Graphiti). Onyx is a strong reference for enterprise retrieval patterns.

## Decision
Use **pgvector** as the default vector store — one fewer system to operate, and
co-located with OLTP for transactional consistency on writes. Add **Qdrant** as
an optional backend behind the retrieval interface when an org exceeds
pgvector's comfortable scale. Use **Graphiti** for the temporal memory graph.
Borrow Onyx retrieval patterns; do not hard-depend on it.

## Consequences
- Simpler ops for most orgs; scale path exists without rearchitecting.
- Retrieval is an interface (vector backend swappable).
- Hybrid search (vector+BM25+recency) and the permission filter sit above the
  backend, so they are backend-agnostic.
