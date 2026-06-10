# MVP Completion — Plan & Model Strategy

**Status:** Proposed · **Date:** 2026-06-10 · **Owner:** Product/Eng
**Companion docs:** [`01-technical-specs.md`](./01-technical-specs.md) · [`../../tasks/mvp-backlog.md`](../../tasks/mvp-backlog.md) · gap analysis in [`../MVP-GAP.md`](../MVP-GAP.md)

> This plan turns the current **in-browser demo** into a **working MVP** that
> delivers the vision's north-star: a real user connects real company knowledge,
> a real LLM turns a meeting into governed, cited memory, and an external agent
> (Claude over MCP) can answer "what did we decide about X?" from that company's
> actual data — all persisted, permission-aware, and audited.

---

## 1. The one e2e thread we are building

Everything below exists to make this single thread real, end to end, surviving a
server restart:

```
Real OIDC login (Keycloak)
  → connect real Notion (read-only OAuth)
  → ingest real docs → real embeddings → pgvector (permission-aware, source ACLs)
  → meeting transcript (Zoom webhook or manual upload) fires the flagship workflow
  → REAL LLM agent (Claude) extracts grounded, cited memory (decisions/risks/actions)
  → eval gate (LLM judge + deterministic) + human approval gate
  → durable memory_write to Postgres/pgvector
  → REAL Slack notify (after approval)
  → external Claude client over REAL MCP retrieves the new memory under governance
  → full, persistent, exportable audit trail of every step
```

If a task does not move this thread forward, it is out of MVP scope (see §6).

---

## 2. Why this is a build, not a patch

The orchestration engine (workflow execution, approvals, ReBAC, audit, budgets,
eval-gating mechanics, MCP *semantics*) is **already implemented and tested** —
that is the moat and we keep it. The MVP work is crossing four reality
boundaries that currently don't exist anywhere in the running system:

| Boundary | Today | MVP target |
| --- | --- | --- |
| **Runtime** | All logic runs client-side in the browser tab | Server-side service(s); browser is a thin client |
| **Persistence** | In-memory, resets on reload | Postgres + pgvector; survives restart |
| **Intelligence** | Hardcoded extraction, bag-of-words, heuristic judges | Real Claude agents, real embeddings, LLM judges |
| **Connectivity** | 8 boolean toggles, 0 real integrations | ≥1 real inbound connector + ≥1 real outbound + real MCP |
| **Identity** | Hardcoded `alice`/admin, single org | Real OIDC login, server-enforced authz, real tenant |

The business logic already sits behind clean interfaces (`AgentHandler`,
`Evaluator`, `MemoryStore`, `AuthzEngine`, the gateway's typed tools), so most
of this is **wiring real implementations into existing seams** — not a rewrite.

---

## 3. Workstreams & dependency graph

Six workstreams. W0/W1/W2 are the foundation (no value lands without them); W3/W4
are where value becomes visible; W5 is the differentiating wedge; W6 proves and
hardens the whole thread.

```
W0 Server runtime & trust boundary ─┬─▶ W1 Persistence ─┐
   (browser → server, API+MCP host) │                   │
                                     └─▶ W2 Identity &   │
                                         multi-tenancy   │
                                              │          │
        ┌─────────────────────────────────────┴──────────┴────────┐
        ▼                                                          ▼
W3 AI (agents, embeddings, judges)              W4 Connectors & ingestion
        │                                                          │
        └──────────────────────────┬───────────────────────────────┘
                                    ▼
                          W5 MCP server (the wedge)
                                    │
                                    ▼
        W6 Flagship e2e · observability · security · trust UX
```

- **W0** unblocks everything — until logic runs server-side with a real API, no
  other boundary can be crossed securely.
- **W1 + W2** can proceed in parallel once W0's API surface is fixed.
- **W3 + W4** are largely independent of each other and parallelizable.
- **W5** needs the server-side gateway (W0) + authz (W2).
- **W6** is last but its e2e spec is written first (it defines "done").

---

## 4. Model-tier strategy (Fable · Opus · Sonnet · Haiku)

This is the heart of the request: **why each task needs the model tier it's
assigned.** There are two distinct model-selection concerns — keep them separate:

> **(A) Build-time tier** = which Claude subagent model *develops* a task.
> **(B) Runtime model** = which Claude model the *product* calls in production
> (agents, judges). Covered in `01-technical-specs.md` §W3; summarized in §5.

### 4.1 Build-time tiers — the four-tier ladder

The existing `docs/06-subagent-strategy.md` defines Opus/Sonnet/Haiku. We **add
Fable 5 as a top tier above Opus** for the small set of tasks that are both
*novel* and *catastrophic-if-wrong*. Grounded model facts (from the Claude model
catalog):

| Tier | Model ID | Rel. cost (in/out $/MTok) | Use for |
| --- | --- | --- | --- |
| **Fable 5** | `claude-fable-5` | $10 / $50 | The ~3–4 hardest tasks: novel cross-cutting architecture + security boundaries where a wrong call is catastrophic and irreversible. Reserve deliberately. |
| **Opus 4.8** | `claude-opus-4-8` | $5 / $25 | Deep reasoning, security/authz, data models, DSL, engine core, provider integration, ADRs, multi-service refactors, reviewing high-risk output. |
| **Sonnet 4.6** | `claude-sonnet-4-6` | $3 / $15 | The bulk of implementation: feature code, connectors, React, APIs, integration/BDD tests, manifests-with-judgment. |
| **Haiku 4.5** | `claude-haiku-4-5` | $1 / $5 | Mechanical/high-volume: scaffolding, config/YAML from templates, fixtures/seed data, Dockerfiles from a pattern, manifest boilerplate. |

### 4.2 Decision rubric (extends `06-subagent-strategy.md §2`)

Score the task on five axes; **highest axis wins**.

| Axis | Haiku | Sonnet | Opus | **Fable** |
| --- | --- | --- | --- | --- |
| **Ambiguity** | Fully specified | Some interpretation | Trade-offs open | Problem itself is under-defined; the design *is* the deliverable |
| **Blast radius** | One file | One service | Cross-service / security / data model | Sets the architecture every other task depends on |
| **Novelty** | Template exists | Known pattern | New abstraction | No prior art in this repo; getting the abstraction wrong forces a re-do of many tasks |
| **Reversibility** | Trivial | Reversible w/ effort | Hard (schema/authz/DSL) | Effectively irreversible once built on |
| **Cost of error** | Cosmetic | Localized bug | Security/correctness incident | Silent data-leak or undetectable-corruption class of failure |

**Hard rule (unchanged):** anything touching authz, secrets, the DSL, data
models, or the engine core is **Opus or Opus-reviewed regardless of size**.

**New Fable rule:** escalate to Fable **only** when a task scores top-of-column
on **≥3 of the 5 axes** *and* is on the critical path for ≥3 downstream tasks. In
this plan that is exactly four tasks (see §4.3). If in doubt, use Opus and have
**Fable review** the result rather than spending Fable to author it.

### 4.3 The four Fable-tier tasks (and why each clears the bar)

| Task | Why Fable, not Opus |
| --- | --- |
| **T0.1 — Server runtime & trust-boundary architecture (ADR-0008)** | Decides modular-monolith vs microservice split, where the trust boundary lands, and the API/MCP host shape. **Every** W1–W6 task builds on it; reversing it means re-doing the wiring. Novel for this repo, irreversible, highest blast radius. |
| **T1.3 — Durable workflow execution (persist + resume across restart)** | Correctness-critical concurrency: at-least-once with dedupe keys, idempotent steps, pause/resume that survives a crash mid-approval. A subtle bug here double-fires external effects (duplicate Jira tickets, double Slack sends) or loses a run — silent and hard to detect. Novel relative to the in-memory engine. |
| **T4.1 — Connector SDK v2 + source-ACL mapping framework** | This is *the* security promise of the product: ingested objects must carry faithful source permissions or the "permission-aware brain" leaks data a user shouldn't see. Mapping heterogeneous source ACLs (Notion/Drive/Slack) to the ReBAC model correctly, generically, is novel and a data-leak-class failure if wrong. |
| **T5.1 — Real MCP server transport + external trust boundary** | First point where *external* agents (Claude/Cursor) reach company data over the network. Protocol correctness + OIDC-client→principal→authz/audit on every call. A gap here is an unauthenticated path to the whole brain. Novel (no real transport exists today) and catastrophic-if-wrong. |

Everything else is Opus (judgment/security/data-model), Sonnet (build), or Haiku
(mechanical) per the rubric. Per-task rationale is in
[`../../tasks/mvp-backlog.md`](../../tasks/mvp-backlog.md).

### 4.4 Cost discipline (extends `06 §7`)

- Fable is reserved for the ~10% of decisions that determine the other 90% — at
  $10/$50 per MTok it is 2× Opus; spend it only on the four tasks above.
- Prefer **"Opus authors, Fable reviews"** over **"Fable authors"** whenever the
  task is hard but not novel — review is cheaper than authorship and catches the
  same class of error.
- Run independent Sonnet feature tasks and Haiku scaffolds in parallel; batch
  Haiku manifest/config tasks.
- All tiers obey the same evidence contract (`docs/05`): red→green tests, BDD per
  FR, e2e per journey. No tier is exempt.

---

## 5. Runtime model choices for the product's AI (summary)

The product itself calls Claude at runtime. Defaults (full detail + params in
`01-technical-specs.md §W3`):

| Product AI feature | Default model | Why |
| --- | --- | --- |
| Flagship extraction agent (transcript → cited memory) | `claude-opus-4-8` | Grounded, structured extraction with citations is intelligence-sensitive; quality of the memory is the product. Configurable per-agent; budget-metered. |
| LLM judge — factuality / hallucination | `claude-sonnet-4-6` | Judging is higher-volume and runs on every gated output; Sonnet is the speed/cost/quality balance. |
| Cheap pre-filter judges | `claude-haiku-4-5` | Fast, cheap first-pass before spending a Sonnet judge call. |
| Embeddings | A dedicated embeddings model behind the `MemoryStore` seam | Retrieval quality; provider-agnostic. |

All runtime calls: adaptive thinking (`thinking: {type: "adaptive"}`),
structured outputs (`output_config.format`) for extraction, real token usage fed
to the existing budget meter, provider-agnostic behind `AgentHandler`/`Evaluator`.

---

## 6. Scope discipline

**In scope (the e2e thread):** server runtime, Postgres+pgvector persistence,
durable runs, Keycloak OIDC + server-side authz, one real tenant, real Claude
agents + embeddings + LLM judge, **one** real inbound connector (Notion) + Zoom
trigger, one real outbound (Slack), real MCP server, flagship e2e, observability,
security pass, honest trust UX.

**Explicitly deferred:** the other 6 connectors; Temporal/Trigger.dev at scale
(durable-in-Postgres suffices); Graphiti temporal graph (hybrid search
suffices); Qdrant (pgvector is default); self-serve multi-tenant org creation
(one secured tenant suffices); mobile; marketplace billing.

**Added to scope (gap-doc findings, MVP-critical, not in original plan):**
honest demo-vs-live UI labeling, first-run/empty-state flows, app-level
credential/token storage for connectors, async progress states.

---

## 7. Definition of Done (the MVP is "real" when…)

All true for ≥1 real tenant, **surviving a server restart**:

- [ ] Real OIDC login; no hardcoded principal; authz enforced **server-side**.
- [ ] Real Notion connected via OAuth; real docs ingested with faithful ACLs.
- [ ] Brain search over real data using real embeddings, with provenance + permission filtering.
- [ ] A workflow run uses a **real Claude agent** producing grounded, cited memory; budget metered from real tokens.
- [ ] Eval gate (LLM judge) + human approval can **block** an external action; negative path produces no side effects.
- [ ] One **real** outbound effect (Slack) fires after approval.
- [ ] An external Claude client connects over **real MCP** and retrieves that tenant's brain under governance.
- [ ] Every step persisted and visible in a durable, exportable audit trail.
- [ ] Flagship Playwright e2e proves the whole thread with artifacts; CI builds images and runs it.

Each item maps to tasks in [`../../tasks/mvp-backlog.md`](../../tasks/mvp-backlog.md)
and a test layer per `docs/05-development-methodology.md`.
