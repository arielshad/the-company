# PHASE-02 — Company Brain (MVP-2)

**Goal:** Connect Notion + Google Drive + GitHub, ingest into a permission-aware
brain, search it (hybrid + permission filter), write memory from meetings/docs,
and expose `brain.search`/`brain.write` via MCP. This is the core IP and is
security-sensitive — heavily Opus-owned.

**Exit criteria:** Documents from three sources are searchable; restricted docs
are hidden from unauthorized principals; a meeting summary can be written as a
typed memory object with provenance; `brain.search` returns cited results via MCP.

**Dominant tiers:** **Opus** (retrieval, permission filter, memory model,
graph) + Sonnet (ingestion workers, connectors).

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T02.1 | `brain` service + schema: memory_objects, chunks, embeddings (pgvector), source_acls | FR-3.1,3.4 | **Opus** | Integration: migrations + RLS |
| T02.2 | Ingestion pipeline: extract→chunk→embed→upsert; idempotent per source object | FR-3.1, NFR-3 | Sonnet | Integration: re-ingest is idempotent (dedupe key) |
| T02.3 | Source-ACL capture & storage on ingest | FR-2.5,3.5 | **Opus** | Unit/Integration: ACL persisted + linked |
| T02.4 | Hybrid retrieval: vector + BM25 + recency fusion | FR-3.2 | **Opus** | Unit (TDD): ranking; integration: relevance fixtures |
| T02.5 | **Permission-aware search**: OpenFGA + source-ACL intersection filter | FR-3.5, NFR-1 | **Opus** | BDD: restricted doc hidden / shown (flagship security scenario) |
| T02.6 | Typed memory write API + provenance + lifecycle (supersede/expire/soft-delete) | FR-3.6,3.7 | **Opus** | BDD: write/supersede/expire; audit on each |
| T02.7 | Graphiti temporal graph: entities + valid-time edges (people/projects/customers/decisions) | FR-3.3 | **Opus** | Integration: time-travel query returns correct snapshot |
| T02.8 | Notion connector: backfill + incremental + ACL extraction | FR-2.1,2.2,2.5 | Sonnet | Contract + integration vs Notion mock |
| T02.9 | Google Drive connector | FR-2.1,2.2,2.5 | Sonnet | Contract + integration vs Drive mock |
| T02.10 | GitHub connector (repos/docs/PRs) | FR-2.1,2.2,2.5 | Sonnet | Contract + integration vs GitHub mock |
| T02.11 | Connector OAuth + sealed-secret token storage + scopes | FR-2.3, NFR-1 | **Opus** | Integration: least-privilege scopes; no token in logs |
| T02.12 | Connector health/last-sync/error surface (API) | FR-2.4 | Haiku | Integration: status reported |
| T02.13 | Gateway tools: `brain.search`, `brain.write` (authz + budget + audit) | FR-3.8,7.* | **Opus** | Contract: MCP tool schemas; BDD authz + audit |
| T02.14 | Web: connector setup/health UI + brain search UI with provenance | FR-2.4,3.* | Sonnet | e2e: connect mock source → search → cited results |
| T02.15 | Data lineage: memory → source object → ingestion run | FR-8.6 | Sonnet | Integration: lineage resolves end-to-end |
| T02.16 | Kustomize base + Argo App for `brain` + `connectors`; vector namespace per org | NFR-2,8 | Sonnet | `kustomize build`; per-org namespace isolation test |
| T02.17 | Perf: search p95 < 800ms @ 1M chunks/org | NFR-4 | **Opus** (design)/Sonnet | k6: p95 budget met on seeded dataset |

**Security note:** T02.5 and T02.3/T02.11 are the highest-risk items — a leak
here exposes company data to the wrong principal. Mandatory `/security-review`.
