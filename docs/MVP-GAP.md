# MVP Gap Analysis — What's Mock, What's Missing, What It Takes to Deliver Real Value

**Author:** Product (analysis)  ·  **Date:** 2026-06-10  ·  **Status:** Assessment

> **TL;DR** — CompanyOS today is an exceptionally well-architected **in-browser
> demo**, not a working product. The orchestration brain (workflow engine,
> governance, approvals, audit, permission-aware search, MCP tool dispatch) is
> genuinely implemented and well-tested — but it runs entirely in the user's
> browser tab, on **hardcoded demo data**, with **no real AI**, **no real
> connectors**, **no persistence**, and **no login**. Nothing a user does
> survives a page reload, and no data ever enters or leaves the system. To give
> real value, the MVP must cross four hard boundaries it has not yet crossed:
> (1) a real LLM, (2) real data in (connectors), (3) real data persisted, and
> (4) real identity. This document inventories the gap and sequences the work.

---

## 1. How to read this document

The repo's own `IMPLEMENTATION.md` is admirably honest: it calls out "interface
seams" with in-memory implementations. This document goes one step further and
answers the product question the engineering docs don't: **"If a real customer
installed this tomorrow, what would actually happen — and what has to be true
for them to get value?"**

The answer today: a customer would see a beautiful UI, click "Connect Notion,"
watch a green dot appear, search a brain that only contains three hardcoded
paragraphs, run one workflow that always extracts the same fictional "Globex Q3
renewal" meeting, and lose all of it on refresh. That is a **sales demo**, not
an MVP.

---

## 2. What genuinely works today (give credit where due)

This is not vaporware. The **hard, differentiating middle layer is real** and
deterministically tested (118 passing tests). These are assets, not gaps:

| Capability | Status | Where |
| --- | --- | --- |
| Workflow DSL + validator (invariants) + canvas→DSL compiler | ✅ Real | `packages/dsl` |
| Workflow engine: all node types, branching, bounded loops, **pause/resume approvals** | ✅ Real | `apps/workflow-engine/src/index.ts` |
| ReBAC authorization algorithm (OpenFGA-compatible) | ✅ Real | `packages/auth/src/index.ts` |
| Permission-aware search (OpenFGA relations ∩ source ACL) | ✅ Real | `apps/brain/src/index.ts:196` |
| Append-only, tamper-evident audit log (rolling digest) | ✅ Real | `packages/telemetry` |
| Budget metering + hard-stop enforcement | ✅ Real | `apps/governance`, `packages/telemetry` |
| Human approvals (request → pause → decide → resume, timeout/escalation) | ✅ Real | `apps/governance/src/index.ts` |
| Eval-gating mechanics (suite runs, blocks external effects) | ✅ Real (heuristic judges) | `apps/eval-service` |
| MCP gateway semantics (authn → policy-filtered catalog → authz per call → audit) | ✅ Real (in-process) | `apps/gateway/src/index.ts` |
| Durable SQLite stores (authz, audit, brain) proven across restart | ✅ Real (but unused by app) | `packages/auth/src/sqlite.ts`, etc. |
| Real OpenFGA adapter, CI-verified against a live server | ✅ Real (but unused by app) | `packages/auth/src/openfga.ts` |
| Production-grade IaC: Argo app-of-apps, Keycloak, OpenFGA, Postgres, sealed secrets | ✅ Real (templates) | `infra/` |
| React UI: dashboard, brain, connectors, agents, workflow builder, governance, onboarding | ✅ Real (drives in-memory platform) | `apps/web` |

**The governance/orchestration engine is the moat, and it exists.** The gap is
everything that connects that engine to reality.

---

## 3. The core architectural gap (read this first)

Everything the user touches in the app runs **client-side, in the browser's JS
heap**, via a single seeded singleton (`apps/web/src/app/lib/platform.ts`). The
nine "microservices" in `apps/` are compiled into the browser bundle as
libraries — they are **not running services**. The Node "BFF" exposes only
**four endpoints** (`/healthz`, `/readyz`, `/api/builder/palette`,
`/api/builder/compile`); it never touches the brain, agents, governance, or
persistence.

Consequences, in plain product terms:

- **No persistence.** `Settings.tsx` says it out loud: *"Data is in-memory and
  resets on reload."* A user's connections, memories, agents, and audit trail
  vanish on refresh.
- **No backend.** Two browser tabs are two separate universes. There is no
  shared state, no server of record, nothing multi-user.
- **No security boundary.** Authorization runs in the browser, where the user
  controls everything. The "tamper-evident audit log" lives in the same tab as
  the user it's supposed to hold accountable.
- **No real identity.** The user is hardcoded as `alice` (admin). There is no
  login.

This is the single most important framing for the MVP: **we are not "filling in
a few adapters." We are moving the entire platform from the browser to a real
backend, then connecting it to reality.** The good news is the business logic is
already written and tested behind interfaces — the move is mechanical, not a
rewrite.

---

## 4. Mock / missing inventory (the full picture)

Legend: ❌ absent · 🟡 simulated/stub · 🟢 real but not wired into the running app

### 4.1 Artificial Intelligence — the product is "AI agents" and there is no AI

| Thing | Status | Reality |
| --- | --- | --- |
| LLM agent runs | 🟡 | `extract_meeting` returns a **hardcoded** "Globex — Q3 renewal" object regardless of input (`platform.ts:79`). No model is ever called. `mockModelClient` returns `"handled: " + prompt.slice(0,40)` (`apps/agent-registry`). |
| Eval judges (factuality, tone, hallucination) | 🟡 | Deterministic heuristics. `factuality` is literally an alias for token-overlap `sourceCoverage`. `tone` is a 4-word blocklist. No LLM judge. |
| Embeddings / semantic search | 🟡 | "Bag-of-words" term-frequency cosine. No embedding model; "SSO" and "single sign-on" are unrelated to it. |
| Vector store | ❌ | No pgvector/Qdrant. `MemoryStore` has in-memory + SQLite, both scanning bag-of-words. |
| Temporal memory graph (Graphiti) | ❌ | Named in vision/UI; no entity/edge graph code exists. |
| MCP transport | ❌ | `@modelcontextprotocol/sdk` is not even a dependency. The "gateway" is in-process TypeScript calls. **No external agent (Claude/Cursor) can connect to anything.** |

**Net:** The headline promise — "managed AI workforce on your company brain" —
has **zero AI** behind it today.

### 4.2 Connectors & ingestion — the product is "your company knowledge" and no knowledge flows in

| Thing | Status | Reality |
| --- | --- | --- |
| Notion, Drive, GitHub, Slack, Gmail, Calendar, Jira connectors | ❌ | **None exist in code.** They are 8 hardcoded UI cards with a boolean toggle. |
| Zoom connector | 🟡 | A pure function that reshapes a transcript **handed to it**. No Zoom API, OAuth, webhook, or polling. Fabricates a fake `zoom.example` URL. |
| OAuth / credential storage | ❌ | No OAuth flow anywhere; no token vault/secret handling in the app path. |
| Initial backfill + incremental sync | ❌ | No sync engine, no scheduler, no webhook receiver. |
| Brain contents | 🟡 | **Three hardcoded paragraphs** seeded at startup (ICP, SSO epic, Q3 board). |
| Outbound Jira "create ticket" | 🟡 | Pushes `{id, summary}` to an in-memory array. No Jira API. |
| Outbound Slack "notify" | 🟡 | Pushes `{channel, text}` to an in-memory array. No Slack API. |

**Net:** Clicking "Connect" is theater. No byte of real company data ever enters
or leaves the system.

### 4.3 Platform — no persistence, identity, or tenancy

| Thing | Status | Reality |
| --- | --- | --- |
| Persistence (running app) | 🟡 | In-memory singleton; resets on reload. SQLite stores exist (🟢) but are never instantiated by the app. Postgres/pgvector ❌ absent in code. |
| Authentication / SSO | ❌ | User hardcoded `alice`/admin. No login screen, no Keycloak/OIDC redirect, no token validation. Keycloak IaC exists but nothing calls it. |
| Authorization enforcement boundary | 🟡 | ReBAC is real but runs **in the browser** — not a trust boundary. |
| Multi-tenancy | 🟡 | `orgId` scoping is real in code, but a single org `"acme"` is hardcoded. No create-org API or UI. |
| Backend API | ❌ | BFF has 4 demo endpoints; services aren't reachable over HTTP. |
| Deployability | 🟡 | Only `web` has a Dockerfile. The other 8 services have K8s manifests but **no Dockerfile and no service entrypoint** — they cannot be built or run as containers. |
| Observability (OTel traces/metrics) | ❌ | Declared in NFRs; not wired. |
| Data export/delete (GDPR), PII tagging | ❌ | Not implemented. |

---

## 5. Gap analysis by capability → what "real value" requires

For each pillar: the promise, today's reality, and the **minimum** that makes it
real.

### 5.1 Company Brain (the foundation — "brain first")
- **Promise:** Ask "what was decided about X, by whom, why" and get a cited,
  permission-aware answer from real company knowledge.
- **Reality:** 3 hardcoded paragraphs, bag-of-words match, lost on reload.
- **Minimum for real value:**
  1. **One real connector** end-to-end (recommend **Notion** or **Google
     Drive** — read-only OAuth, simplest path to real documents) with backfill +
     incremental sync.
  2. **Real embeddings** (an embeddings model) + **pgvector** behind the existing
     `MemoryStore` interface. Keep hybrid (vector + keyword + recency) scoring.
  3. **Real persistence** (Postgres) so ingested memory survives.
  4. Source-ACL capture from the real source (already modeled — must be populated
     from real permissions, not `{public:true}`).
- **Hardest sub-gap:** mapping each source's native permissions to source ACLs
  faithfully, or the "permission-aware" promise becomes a leak.

### 5.2 AI Agents (the headline — "managed AI workforce")
- **Promise:** Role-based agents that read the brain, reason, use tools, respect
  budgets, and produce trustworthy output.
- **Reality:** Canned JSON; no model call.
- **Minimum for real value:**
  1. A **real LLM provider client** behind `AgentHandler` (the seam exists). Use
     the latest, most capable Claude model as the default for extraction/reasoning
     quality.
  2. Real token accounting from the provider feeding the (already real) budget
     meter and audit.
  3. At least the **flagship "transcript → structured memory"** agent producing
     real, grounded extraction with citations into the brain.
- **Note:** Budget metering, audit, and eval-gating are already built to receive
  this — wiring a real model lights up a lot of latent value at once.

### 5.3 Evals & governance of AI output
- **Promise:** Block low-quality/hallucinated/unsafe output before it acts.
- **Reality:** Heuristic judges (token overlap, blocklist). The *gating
  machinery* is real; the *judgment* is not.
- **Minimum for real value:** Replace `factuality` and `hallucination_risk` with
  a budgeted **LLM judge** (seam exists), keep deterministic `policy`/`source_coverage`
  as cheap pre-filters. Source-coverage on real citations is already meaningful.

### 5.4 Workflow engine & builder
- **Promise:** Ops users visually build durable, resumable, auditable agentic
  workflows.
- **Reality:** Engine logic is **real and good**; execution is in-process and
  in-memory (a run does not survive a restart in the running app).
- **Minimum for real value:**
  1. Run the engine **server-side** with **durable run state** (Postgres-backed;
     the durable seam/ADR-0003 is planned). The in-memory pause/resume already
     proves the model.
  2. Persist published workflows and run-inspector history.
- **This is closer to done than any other pillar** — it mostly needs to move
  server-side and persist.

### 5.5 MCP gateway (the "every external agent uses our brain" wedge)
- **Promise:** Claude/Cursor/ChatGPT connect over MCP to the governed brain+tools.
- **Reality:** In-process function calls; the MCP SDK isn't even installed. **No
  external client can connect.**
- **Minimum for real value:** Wrap the existing (real) `McpGateway` semantics in
  a **real MCP server transport** (`@modelcontextprotocol/sdk`) exposed over the
  network, with OIDC client auth → principal → existing per-call authz/audit.
  This is high-leverage: the policy logic is done; it needs a transport + auth.

### 5.6 Identity, persistence, tenancy (table stakes)
- **Minimum for real value:** Real OIDC login (Keycloak IaC exists), server-side
  authz enforcement (swap `InMemoryAuthz` → `OpenFgaAuthz`/`SqliteAuthz`, both
  already built), Postgres persistence, and at least the ability to operate one
  real tenant securely. Browser-side authz must be deleted as a trust boundary.

---

## 6. Critical path to an MVP that delivers real value

The strategic insight: **the orchestration engine is built; the MVP is about
crossing four reality boundaries around it.** Sequence by dependency and value.

### Phase A — Make it a real system (no value without this)
*Goal: persist data, run server-side, log in. Without this, nothing else counts.*
1. **Stand up the backend.** Give each needed service a real entrypoint +
   Dockerfile; expose brain/agents/governance/workflow over HTTP. Move
   `platform.ts` logic from the browser to the server; the React app calls APIs.
2. **Persistence.** Wire Postgres (and the existing SQLite/`MemoryStore` seam) so
   memory, agents, workflows, runs, approvals, and audit survive restarts.
3. **Real auth.** Keycloak OIDC login; server-side authz via the existing
   `OpenFgaAuthz`. Delete client-side authorization as a boundary.

### Phase B — Make it intelligent (turns "automation" into "AI")
4. **Real LLM agent** behind `AgentHandler` (latest Claude model), feeding the
   existing budget/audit/eval machinery.
5. **Real embeddings + pgvector** behind `MemoryStore`; keep hybrid scoring.
6. **LLM judge** for `factuality`/`hallucination_risk`.

### Phase C — Make it connected (turns "demo data" into "your company")
7. **One real read connector, fully:** OAuth + backfill + incremental sync +
   faithful source-ACL capture. Recommend **Notion** or **Drive**.
8. **One real outbound action:** real **Slack** notify (or **Jira** create), with
   the approval gate in front (the gate is already built).

### Phase D — Make it open (the MCP wedge)
9. **Real MCP server transport** over the existing gateway, so an external Claude
   client can search the brain and trigger a workflow under governance.

### What this yields
A single, honest, end-to-end thread of real value:

> A real user logs in → connects their real Notion (read-only) → the brain
> ingests and indexes real docs with real permissions → a real Zoom/manual
> transcript runs the flagship workflow → a **real LLM** extracts grounded,
> cited memory → evals + human approval gate it → it's written to **durable**
> brain → a real Slack message goes out → and Claude, over **real MCP**, can now
> answer "what did we decide about X?" from that company's actual knowledge —
> with a full, persistent audit trail.

That is the smallest version of the product that is **more than a RAG chatbot**
and actually delivers the vision's north-star outcomes.

---

## 7. Recommended scope discipline (what to defer)

To reach the thread above without boiling the ocean, explicitly **defer**:
- 7 of 8 connectors (ship **one** real connector; the rest stay "coming soon" —
  and the UI should say so honestly, see §8).
- Temporal/Trigger.dev at scale (durable-in-Postgres is enough for MVP).
- Graphiti temporal graph (hybrid vector+keyword search is enough for MVP).
- Multi-tenant self-serve org creation (one securely-operated tenant is enough).
- Qdrant (pgvector is the stated default).
- Mobile, marketplace billing, air-gapped install (already out of scope in spec).

**Add to scope (currently missing, MVP-critical, not in the engineering docs):**
- An honest **"demo vs. live"** state in the UI (today the UI implies live
  connections that don't exist — a trust risk with buyers).
- **Secret/credential storage** for connector tokens (sealed-secrets exist for
  infra, but there's no app-level token vault).

---

## 8. UX / product-trust gaps (from a UX lens)

The UI is genuinely strong (guided onboarding, React Flow builder, clean
dashboards). But several patterns will **erode trust the moment a real buyer
probes them**, and should be fixed regardless of backend progress:

1. **"Connect" implies a connection that isn't real.** A green "Connected ·
   Synced 1h ago" badge on Notion/Drive/GitHub that is pure fiction is the kind
   of thing that kills enterprise deals when discovered. Until a connector is
   real, label demo connectors explicitly ("Demo data") and gate real ones behind
   a real OAuth flow.
2. **No empty states / no "first real connection" flow.** The app is pre-seeded,
   so there's no designed path for a real user starting from zero (connect →
   backfilling → first results). This is the most important real onboarding
   moment and it doesn't exist yet.
3. **Search results look authoritative but are bag-of-words over 3 docs.** Once
   real, ensure provenance, timestamps, and "why this result" are front-and-center
   to back the "trusted, cited memory" promise.
4. **Approvals/audit are the strongest UX assets** — lean into them in
   positioning; they're real and differentiating. Make the audit log
   exportable (also a compliance requirement).
5. **No feedback for long-running/async reality.** Real ingestion and real LLM
   runs take seconds-to-minutes; the current UI assumes instant in-memory
   results. Needs progress/pending/error states for sync and runs.
6. **Reset-on-reload** must be communicated or (better) eliminated by persistence
   before any non-demo use.

---

## 9. Risk register

| Risk | Severity | Note |
| --- | --- | --- |
| "Looks done" illusion | **High** | 118 green tests + polished UI can read as "shippable." It is a tested *simulation*. Stakeholders must understand Phase A–D is the real build. |
| Permission-aware promise leaks | **High** | If real connectors don't faithfully map source ACLs, the brain will surface things people shouldn't see — the exact failure the product claims to prevent. |
| Security theater | **High** | Browser-side authz/audit is not a security boundary. Must move server-side before any real data. |
| Connector long-tail | **Medium** | Each connector is real auth + sync + ACL + rate-limit work. Resist "just add all 8." |
| LLM cost/latency/quality | **Medium** | Budget meter exists (good), but real eval thresholds and model routing need tuning against real output. |
| MCP compatibility surface | **Medium** | "Works with Claude/Cursor/ChatGPT" needs a real, spec-compliant MCP server + interop testing. |

---

## 10. Definition of "MVP that gives real value" (acceptance)

The MVP is real when **all** of the following are true for at least one real
tenant, and **survive a server restart**:

- [ ] A real user authenticates via OIDC (no hardcoded principal).
- [ ] At least one real source (Notion/Drive) is connected via OAuth and ingested
      with faithful, permission-aware ACLs.
- [ ] Brain search returns results over **real** company data using **real**
      embeddings, with provenance and permission filtering.
- [ ] A workflow run uses a **real LLM** agent that produces grounded, cited
      memory; budget is metered from real token usage.
- [ ] Eval gate + human approval can **block** an external action; the negative
      path produces no side effects.
- [ ] At least one **real** outbound effect (Slack or Jira) fires after approval.
- [ ] An external MCP client (e.g. Claude) connects over a **real** MCP transport
      and retrieves that tenant's brain under governance.
- [ ] Every step above is persisted and appears in a durable, exportable audit
      trail.
- [ ] Authorization is enforced **server-side**; the browser is not trusted.

Until these hold, CompanyOS is best positioned internally as a **high-fidelity
prototype of the orchestration layer** — a strong foundation, but not yet a
product a customer can derive value from.

---

### Appendix — key file references

- In-browser platform singleton (the "whole system"): `apps/web/src/app/lib/platform.ts`
- Hardcoded agent extraction: `apps/web/src/app/lib/platform.ts:79`
- Mock model client: `apps/agent-registry/src/index.ts:15`
- Heuristic evaluators: `apps/eval-service/src/index.ts`
- Bag-of-words search: `apps/brain/src/index.ts:128`
- Zoom "connector" (payload transformer): `apps/connectors/src/index.ts:56`
- Connectors UI (boolean toggle): `apps/web/src/app/pages/Connectors.tsx:11`
- BFF (4 endpoints only): `apps/web/src/index.ts:70`
- "Resets on reload" disclaimer: `apps/web/src/app/pages/Settings.tsx:28`
- Real (but unused-by-app) durable/auth adapters: `packages/auth/src/sqlite.ts`, `packages/auth/src/openfga.ts`, `packages/telemetry/src/sqlite.ts`, `apps/brain/src/sqlite.ts`
- Real engine/governance/audit (the moat): `apps/workflow-engine/src/index.ts`, `apps/governance/src/index.ts`, `packages/telemetry`
