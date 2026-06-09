# PHASE-06 — Connector Expansion

**Goal:** Complete the connector suite beyond the PHASE-02 trio (Notion/Drive/
GitHub): Slack, Gmail, Google Calendar, Zoom, Jira — each with backfill +
incremental sync, OAuth least-privilege, ACL capture, and trigger emission for
workflows. Highly repetitive, pattern-driven work.

**Exit criteria:** Each connector ingests into the brain with provenance + ACLs,
surfaces health/last-sync, stores tokens as sealed secrets with least-privilege
scopes, and emits the workflow triggers it owns (e.g. Zoom transcript, Slack
event, GitHub PR, Jira issue).

**Dominant tiers:** Sonnet (each connector) + Haiku (per-connector config,
scopes, manifests).

A reusable **connector SDK** (`packages/connector-sdk`) is built first so each
connector is a thin, consistent implementation.

| Task | Description | FR/NFR | Tier | Test strategy |
| --- | --- | --- | --- | --- |
| T06.1 | `packages/connector-sdk`: backfill/incremental contract, ACL capture, trigger emit, health | FR-2.* | **Opus** | Unit (TDD): SDK contract; conformance test kit |
| T06.2 | Slack connector (events + channels/messages ingest + slack_event trigger) | FR-2.1,6.3 | Sonnet | Contract + conformance + integration mock |
| T06.3 | Gmail connector | FR-2.1 | Sonnet | Contract + conformance |
| T06.4 | Google Calendar connector (+ calendar trigger) | FR-2.1,6.3 | Sonnet | Contract + conformance |
| T06.5 | Zoom connector (transcripts + zoom_transcript trigger) | FR-2.1,6.3 | Sonnet | Contract + conformance; feeds flagship e2e |
| T06.6 | Jira connector (issues ingest + jira_issue trigger + task target) | FR-2.1,6.3,9.2 | Sonnet | Contract + conformance |
| T06.7 | Per-connector OAuth scopes + sealed secrets + token rotation | FR-2.3, NFR-1 | Haiku (config) / **Opus** (review) | Integration: least-privilege; rotation works |
| T06.8 | Connector health dashboard (all connectors) | FR-2.4 | Sonnet | e2e: health states render |
| T06.9 | Kustomize/Argo: connector workers as scalable deployment(s) | NFR-5,8 | Haiku | `kustomize build`; HPA scale test |

**Conformance kit:** T06.1 ships a connector conformance test suite every
connector must pass (idempotent sync, ACL captured, health reported, trigger
emitted) — this keeps the repetitive work honest and lets Sonnet/Haiku move fast
without regressing the security model.
