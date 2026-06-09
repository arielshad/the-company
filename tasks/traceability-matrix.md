# Traceability Matrix

Maps every requirement → the phase/tasks that implement it → the test layer that
proves it. Kept current as tasks complete (add the PR + evidence link in the
"Proof" column). This is how we keep delivery **evidence-based**: no requirement
is "met" without a row pointing at a passing test artifact.

## Functional requirements

| Req | Summary | Phase / Tasks | Primary test layer | Proof (PR/artifact) |
| --- | --- | --- | --- | --- |
| FR-1.1 | Keycloak SSO | T00.8, T00.13 | e2e + integration | _pending_ |
| FR-1.2 | Multi-tenant by org | T00.11, T01.1, NFR-2 tasks | integration (RLS) | _pending_ |
| FR-1.3 | Role model | T00.13 | integration | _pending_ |
| FR-1.4 | OpenFGA fine-grained authz | T00.4, T01.7, T02.5 | integration + BDD | _pending_ |
| FR-1.5 | Service-to-service auth | T00.13 | integration | _pending_ |
| FR-2.1 | Connectors (8) | T02.8–10, T06.2–6 | contract + conformance | _pending_ |
| FR-2.2 | Backfill + incremental | T02.2, T06.1 | integration | _pending_ |
| FR-2.3 | Connector OAuth least-priv | T02.11, T06.7 | integration | _pending_ |
| FR-2.4 | Connector health | T02.12, T06.8 | e2e | _pending_ |
| FR-2.5 | Source ACL capture | T02.3, T06.1 | integration | _pending_ |
| FR-3.1 | Ingestion pipeline | T02.1, T02.2 | integration | _pending_ |
| FR-3.2 | Hybrid retrieval | T02.4 | unit + integration | _pending_ |
| FR-3.3 | Temporal memory graph | T02.7 | integration | _pending_ |
| FR-3.4 | Typed memory objects | T02.1 | unit | _pending_ |
| FR-3.5 | Permission-aware search | T02.5 | **BDD (security)** | _pending_ |
| FR-3.6 | Memory write + provenance | T02.6 | BDD | _pending_ |
| FR-3.7 | Memory lifecycle | T02.6 | BDD | _pending_ |
| FR-3.8 | brain.search/write via MCP | T02.13 | contract + BDD | _pending_ |
| FR-4.1 | Agent CRUD | T01.1, T01.2 | BDD | _pending_ |
| FR-4.2 | Org chart | T01.3, T01.10 | unit + e2e | _pending_ |
| FR-4.3 | Budget enforcement | T01.4 | unit + BDD | _pending_ |
| FR-4.4 | Agent templates | T01.5 | unit | _pending_ |
| FR-4.5 | Manual task run | T01.6 | integration | _pending_ |
| FR-4.6 | Activity/eval feed | T01.11, T08.4 | e2e | _pending_ |
| FR-5.1 | Skill package format | T05.1, T05.2 | unit | _pending_ |
| FR-5.2 | Skill sources (Notion/GitHub) | T05.4, T05.5 | integration | _pending_ |
| FR-5.3 | Skill metadata/roles | T05.1, T05.3 | BDD | _pending_ |
| FR-5.4 | Sync engine | T05.4 | integration | _pending_ |
| FR-5.5 | Department namespaces | T05.3, T05.8 | BDD | _pending_ |
| FR-5.6 | Skills runnable | T05.6 | contract + BDD | _pending_ |
| FR-5.7 | Eval-gated promotion | T05.7, T08.3, T08.8 | **BDD (gate)** | _pending_ |
| FR-6.1 | Visual builder | T03.1, T03.5 | unit + e2e | _pending_ |
| FR-6.2 | 13 node types | T03.2, T04.* | unit + integration | _pending_ |
| FR-6.3 | Triggers | T03.3, T04.14 | integration | _pending_ |
| FR-6.4 | DSL compile | T03.4, T03.9 | unit (round-trip) | _pending_ |
| FR-6.5 | Durable execution | T04.1, T04.2 | integration | _pending_ |
| FR-6.6 | Human-in-the-loop | T04.8 | BDD | _pending_ |
| FR-6.7 | Run inspector | T04.13 | e2e | _pending_ |
| FR-6.8 | Workflow versioning | T03.8, T03.9 | e2e | _pending_ |
| FR-6.9 | Per-workflow policies | T03.10 | unit | _pending_ |
| FR-7.1 | MCP tool endpoint | T00.7, T02.13 | contract | _pending_ |
| FR-7.2 | Per-client authz | T00.7, T01.8 | BDD | _pending_ |
| FR-7.3 | Policy-filtered catalog | T01.8 | BDD | _pending_ |
| FR-7.4 | Rate limit + budget + audit | T00.7, T02.13 | integration | _pending_ |
| FR-7.5 | MCP client compatibility | T04.15 (e2e via MCP) | e2e | _pending_ |
| FR-8.1 | Approval policies | T04.8, T08.6 | BDD | _pending_ |
| FR-8.2 | Eval framework | T08.1, T08.2 | unit + integration | _pending_ |
| FR-8.3 | Eval gating | T04.11, T08.3 | BDD | _pending_ |
| FR-8.4 | Immutable audit | T00.5, T07.12, T08.7 | integration | _pending_ |
| FR-8.5 | Cost/observability dashboard | T08.5 | e2e | _pending_ |
| FR-8.6 | Data lineage | T02.15, T08.7 | integration | _pending_ |
| FR-9.1 | Notify channels | T04.12 | contract | _pending_ |
| FR-9.2 | Task actions | T04.10 | contract | _pending_ |

## Non-functional requirements

| Req | Summary | Phase / Tasks | Proof |
| --- | --- | --- | --- |
| NFR-1 | Security | T00.4/7/13/15, T02.5/11, T07.3/4/10 | `/security-review` clean |
| NFR-2 | Tenancy isolation | T00.11, T01.1, T02.16, T07.7 | cross-tenant test suite |
| NFR-3 | Reliability/durability | T04.1/17, T07.1/2/6 | DR drill, restart tests |
| NFR-4 | Performance | T02.17, T07.8 | k6 budgets |
| NFR-5 | Scalability | T04.16, T06.9, T07.9 | autoscale load test |
| NFR-6 | Observability | T00.16, T07.13, T08.5 | traces/metrics/alerts |
| NFR-7 | Compliance | T07.11, T07.12, T08.7 | export/delete BDD, integrity digest |
| NFR-8 | Portability (K8s) | all infra tasks | Argo healthy on CNCF k8s |
| NFR-9 | Cost control | T01.4, T08.5 | metering tests |
| NFR-10 | Accessibility | T03.11 | axe in e2e |
