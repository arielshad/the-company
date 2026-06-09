# PHASE-07 — Reliability, Scale & Security Hardening

**Goal:** Take the working MVP to enterprise-grade: durable execution at scale
(Temporal), service mesh + mTLS, multi-env promotion, DR, perf targets, and a
full security pass. Design-heavy → Opus; implementation → Sonnet.

**Exit criteria:** NFR-1..9 met and demonstrated: Temporal-backed durability,
mesh mTLS, NetworkPolicy default-deny verified, RPO≤5m/RTO≤30m proven by a DR
drill, perf budgets met under load, and a clean security review.

**Dominant tiers:** **Opus** (durability migration design, mesh/security,
DR design) + Sonnet (implementation, manifests).

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T07.1 | Workflow-engine executor abstraction: add Temporal backend behind same interface | NFR-3,5 | **Opus** | Integration: same DSL runs on Temporal; parity suite |
| T07.2 | Migrate flagship + heavy workflows to Temporal; keep Trigger.dev for light jobs | NFR-3 | Sonnet | e2e parity; durability/restart tests |
| T07.3 | Service mesh (Linkerd) + mTLS in-mesh | NFR-1 | **Opus** (design)/Sonnet | Integration: mTLS enforced; plaintext refused |
| T07.4 | NetworkPolicies default-deny + declared paths; egress controls | NFR-1 | **Opus** | Policy test: undeclared path blocked |
| T07.5 | Staging + prod overlays; promotion via image-tag PR; Argo sync waves | §07 | Sonnet | Promote dev→staging→prod dry run |
| T07.6 | Backups (Postgres PITR, object store), restore runbook | NFR-3,7 | Sonnet | DR drill: restore within RTO; RPO verified |
| T07.7 | Tenancy isolation hardening: RLS audit, per-org vector namespaces, OpenFGA namespacing review | NFR-2 | **Opus** | Cross-tenant leakage test suite |
| T07.8 | Perf/load: brain search, builder, workflow throughput vs NFR-4 | NFR-4 | **Opus** (plan)/Sonnet | k6 budgets met; flamegraphs archived |
| T07.9 | HPA/VPA + resource tuning per service | NFR-5 | Sonnet | Load test autoscale behavior |
| T07.10 | Full `/security-review` + threat-model validation + secret-scan in CI hardened | NFR-1 | **Opus** | No unresolved high; injection/exfil tests pass |
| T07.11 | Data export & delete per org (GDPR-style) + PII tagging | NFR-7 | **Opus** (design)/Sonnet | BDD: export + verifiable delete |
| T07.12 | Audit immutability + periodic integrity digest | FR-8.4, NFR-7 | **Opus** | Integration: tamper detected by digest |
| T07.13 | SLOs + alerting (Prometheus rules, runbooks) | NFR-6 | Sonnet | Alert fires on injected fault |

**Note:** This phase is where "ready for deployment on a k8s cluster" becomes
"safe to run for a real company." Security and durability items are Opus-owned
and gated by mandatory security review.
