# PHASE-08 — Governance Depth, Evals & Observability

**Goal:** Complete the governance promise: the full eval framework, agent
evaluation scores, cost/observability dashboards, approval analytics, and
audit/compliance reporting. This is where the product becomes defensibly
"enterprise governance," not just "agents that run."

**Exit criteria:** Evals run as advisory or blocking gates with thresholds;
agents carry evaluation scores; an admin sees spend + success-rate + eval scores
+ latency by agent/workflow/skill; approvals have analytics; auditors can export
a complete, immutable trail with lineage.

**Dominant tiers:** **Opus** (eval design, gating correctness, scoring rubrics)
+ Sonnet (runners, dashboards).

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T08.1 | `eval-service`: runner framework for quality/factuality/policy/tone/source_coverage/hallucination | FR-8.2 | **Opus** | Unit (TDD): each eval scores known fixtures correctly |
| T08.2 | LLM-judge harness (budgeted + audited) with calibration set | FR-8.2 | **Opus** | Integration: judge stable on calibration; budget enforced |
| T08.3 | Eval gating integration in workflow + skill promotion (block/advisory) | FR-8.3,5.7 | **Opus** | BDD: block prevents external effect; advisory records only |
| T08.4 | Agent evaluation scores feeding agent activity feed | FR-4.6 | Sonnet | Integration: scores attached to agent |
| T08.5 | Cost/observability dashboard: spend & success & eval & latency by agent/workflow/skill/org | FR-8.5 | Sonnet | e2e: dashboard reflects seeded runs |
| T08.6 | Approval analytics (volume, time-to-decision, timeout/escalation rates) | FR-8.1 | Sonnet | e2e: analytics render |
| T08.7 | Audit export + compliance report (immutable, with lineage) | FR-8.4,8.6 | **Opus** | BDD: export complete; lineage resolves; tamper-evident |
| T08.8 | Eval regression suite in CI (skills can't regress below threshold) | FR-5.7 | Sonnet | CI: eval gate blocks regressions |
| T08.9 | Kustomize/Argo for `eval-service`; dashboards provisioned in Grafana | NFR-6,8 | Haiku | `kustomize build`; dashboards load |

**Closeout:** With PHASE-08 complete, all FRs and NFRs in `01-product-spec.md`
are met and traced in `tasks/traceability-matrix.md`. The eval framework's
correctness (T08.1–08.3, T08.7) is Opus-owned because gates that wrongly pass
or block directly undermine the product's core governance claim.
