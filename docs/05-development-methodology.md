# 05 — Development Methodology (TDD · BDD · e2e · Evidence-Based)

This is a **contract**, not a suggestion. Every task in `tasks/backlog.md` is
executed under this methodology, regardless of which model (Opus/Sonnet/Haiku)
performs it. A task is not "done" until it produces the evidence defined here.

---

## 1. The test pyramid

```
        ┌───────────────────────┐
        │   e2e (Playwright)    │   few, high-value user journeys
        ├───────────────────────┤
        │  BDD acceptance       │   Gherkin features per FR; service+contract level
        ├───────────────────────┤
        │  integration          │   service ↔ DB / OpenFGA / queue / provider (mocked)
        ├───────────────────────┤
        │  unit (TDD)           │   many; pure logic, DSL, schemas, policies
        └───────────────────────┘
```

| Layer | Tool | Lives in |
| --- | --- | --- |
| Unit | Vitest | `apps/*/src/**/*.test.ts`, `packages/*` |
| Integration | Vitest + Testcontainers (Postgres, OpenFGA, Redis) | `apps/*/test/integration` |
| BDD acceptance | Cucumber.js (Gherkin) | `apps/*/features` + shared steps in `packages/testing` |
| Contract | Pact (consumer/provider) for service↔service + MCP tool contracts | `apps/*/test/contract` |
| e2e | Playwright | `e2e/` |
| Load/perf | k6 (NFR-4) | `e2e/perf` |

---

## 2. TDD loop (per unit of logic)

**Red → Green → Refactor**, with the red proof captured.

1. Write the failing test first. **Run it and capture the failure output** (the
   "red" evidence) — this proves the test exercises the new behavior.
2. Implement the minimum to pass.
3. Run the test green; refactor with tests staying green.
4. Commit test + implementation together; the commit body references the task id
   and includes the red→green note.

> **Evidence rule:** a PR that adds behavior without a test that was first seen
> failing is rejected by review. "Evidence-based" means we keep the proof, not
> the promise.

---

## 3. BDD (per functional requirement)

Each `FR-x.y` gets at least one Gherkin scenario. Features are written in
business language and live with the owning service. Example:

```gherkin
# apps/brain/features/permission_aware_search.feature
Feature: Permission-aware brain search (FR-3.5)

  Background:
    Given an org "acme" with users "alice" and "bob"
    And a Notion page "Q3 Strategy" restricted to group "leadership"
    And "alice" is in group "leadership" but "bob" is not

  Scenario: Restricted document is hidden from unauthorized user
    When "bob" searches the brain for "Q3 Strategy"
    Then the results do not include "Q3 Strategy"

  Scenario: Authorized user sees the document with provenance
    When "alice" searches the brain for "Q3 Strategy"
    Then the results include "Q3 Strategy"
    And each result cites its source connector and url
```

Shared step definitions live in `packages/testing/steps` so scenarios stay
declarative and reusable across services.

---

## 4. e2e (per user journey)

Playwright drives the real web app against a deployed dev stack (or
Testcontainers/compose). The **flagship e2e** is the Zoom-transcript scenario
(see `01-product-spec.md §6`), which proves the system end-to-end:

```
e2e/scenarios/zoom-to-brain.spec.ts
  - seed: connect mock Zoom connector, post a transcript webhook
  - assert: extraction agent runs, approval is requested for low-confidence,
            approver approves, memory is written with provenance,
            Jira task created (mock), Slack notified (mock),
            brain.search via MCP returns the new memory with sources
  - artifact: trace, screenshots, run-inspector export saved to e2e/artifacts/
```

Every e2e run emits **artifacts** (screenshots, traces, run-inspector JSON)
stored as CI build artifacts — this is the user-facing "evidence".

---

## 5. Evidence-based delivery — the artifact bundle

Every completed task attaches an **evidence bundle** to its PR:

| Evidence | Required for | Form |
| --- | --- | --- |
| Red test output | any behavior change | log snippet / CI link |
| Green test run | all tasks | CI link |
| Coverage delta | all tasks | coverage report (no decrease below gate) |
| BDD scenario result | tasks touching an FR | cucumber report |
| e2e artifacts | user-facing journeys | screenshots + trace |
| Contract verification | service/MCP boundary changes | Pact verification result |
| Perf result | NFR-4 tasks | k6 summary |
| Security scan | dependency/secret/IaC changes | scan report |

The bundle is summarized in the PR description and linked from
`tasks/traceability-matrix.md`.

---

## 6. Definition of Ready (before a task starts)

- Linked to an `FR-`/`NFR-` requirement.
- Acceptance criteria written as Gherkin (at least the happy path).
- Interfaces/schemas it depends on exist (or are stubbed with contracts).
- Subagent tier assigned (see `06-subagent-strategy.md`).

## 7. Definition of Done (see `07-quality-gates.md` for the enforced gates)

- Red→green evidence captured; all tests green in CI.
- BDD scenarios for the FR pass; e2e (if user-facing) passes with artifacts.
- Coverage ≥ gate; lint/typecheck/format clean.
- Contracts verified; security scans clean.
- Docs/ADR updated; traceability matrix row added.
- Manifests updated if the service shape changed (image, config, ports, policy).

---

## 8. Branching, commits, CI

- Trunk-based on `claude/fervent-ritchie-nlfaws` for this engagement; short-lived
  task branches merge via PR with the evidence bundle.
- Conventional Commits (`feat:`, `test:`, `fix:`, `chore:`, `docs:`, `ci:`),
  commit body references the task id.
- CI stages (fail-fast): `lint → typecheck → unit → integration → bdd →
  contract → build → e2e (on PR label or main) → security/IaC scan`.
- No merge if any gate is red. Coverage and eval gates are hard gates.
