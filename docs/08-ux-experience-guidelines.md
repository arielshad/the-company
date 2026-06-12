# 08 — UX & Experience Guidelines

> Living document. The purpose is simple: **a feature is not done when the code
> works — it is done when the user gets the value the UI promised them.** Our
> code gates ([07-quality-gates.md](07-quality-gates.md)) verify the first half.
> This document verifies the second.

## Why this exists (the founding case)

A user connected Notion and asked: *"Should I expect to see something in the
company brain?"* The honest answer was **no** — "Connect" stored an OAuth token
and stopped. No data flowed until the user found a separate **Backfill** button;
there is no auto-sync and no scheduled sync. The word "Connect" promised a
connection; the implementation delivered a stored credential.

The worst part: **we already knew.** [MVP-GAP.md §8.2](MVP-GAP.md) calls the
`connect → backfilling → first results` path *"the most important real
onboarding moment"* and notes *"it doesn't exist yet."* §8.5 says async
ingestion *"needs progress/pending/error states."* It shipped anyway, because
nothing in our Definition of Done checks for it. **118 green tests cannot tell
you that "Connect" leads nowhere** — they verify the code is internally
consistent, not that it does what the UI meant. That gap is what this document
closes.

## The core principle: no promise without a payoff

Every UI affordance is a **promise**. A button labelled "Connect" promises a
connection. A green "Synced" dot promises fresh data. A search box promises
answers. For every promise, there must be:

1. **An enforcement point** — the code that actually delivers it, on the real
   path, end to end. ("It's probably handled by the backfill endpoint" is not
   delivery; the wired call is.)
2. **A truthful state** — the UI reflects reality, including "not yet,"
   "in progress," "partial," and "failed." Never show success the system hasn't
   achieved.
3. **A path to value** — from the promise, the user can reach the payoff without
   already knowing the internal architecture. If reaching value requires knowing
   there's a second button, the flow is broken, not the user.

This is the [`intended-vs-implemented`](.) lens applied to UX: audit the gap
between what the screen says and what the system does. Fictional state (the green
dot on a connector that ingested nothing) is the highest-severity UX bug we have
— it is the class that kills trust the moment a buyer probes it.

## Required states — design all of them, every time

The connector failure was a **missing-states** failure. For any feature that
touches real data, an external system, or an async/long-running operation, design
and build **every** state below. A feature that only handles the happy path is
incomplete, not "v1."

| State | The question it answers | Connector example (what should exist) |
|---|---|---|
| **Empty** | "I have nothing yet — what now?" | Fresh org, brain empty → "Connect a source to start your company brain." |
| **Connecting / acting** | "Is it working? Should I wait?" | OAuth in flight; backfill triggered → spinner + "Importing your Notion pages…" |
| **In progress (async)** | "How far along, how long?" | Ingestion running → "412 of ~1,200 pages indexed" with live count. |
| **Success → value** | "It worked — and here's the payoff." | Backfill done → "1,200 pages in your brain. Try a search." (links to value) |
| **Partial / degraded** | "Some of it worked." | 1,150 ingested, 50 failed ACL mapping → surfaced, not silent. |
| **Error / retry** | "It broke — why, and what do I do?" | Token expired → "Reconnect Notion" with a real action, not a dead dot. |
| **Stale** | "Is this still fresh?" | No sync in 7 days → honest "Last synced 7 days ago," not a perpetual green "Synced." |

If a state can occur in reality, it must exist in the UI. Silent failure and
permanent-optimistic state are the two cardinal sins.

## Time-to-value is a first-class metric

The job a user hires this product for is *"see my company's knowledge become
useful."* Measure and minimize the steps from intent to that payoff.

- **Count the clicks** from "I want to connect Notion" to "I can search my Notion
  in the brain." Today it is: Connect → (find) Backfill → wait → search. Every
  click that requires internal knowledge is friction to remove.
- **Default to the obvious next action.** If connecting a source without
  ingesting it is never what a user wants, connecting should *offer to* (or
  automatically) begin the first backfill, with clear progress — not leave them
  on a dead end. (Tracked: auto-backfill-on-connect + a sync schedule.)
- **The "aha" must be reachable in one session.** If first value requires a
  manual step the UI never points to, the aha never happens.

## UX Definition of Done (the gate this adds)

Add this block to the per-task DoD in
[07-quality-gates.md §3](07-quality-gates.md) for any **user-facing** change.
It is the missing gate — code-green is necessary, not sufficient.

```
UX gate (user-facing changes):
[ ] Every UI promise (button/label/badge) has a wired enforcement point — verified end to end, not assumed
[ ] No fictional state: every status the UI can show reflects something the system actually achieved
[ ] All required states built: empty, in-progress, success→value, partial, error/retry, stale (as applicable)
[ ] Async work shows progress/pending and a truthful completion or failure — never a frozen "instant" assumption
[ ] Time-to-value walked manually from zero: a first-run user reaches the payoff without internal knowledge
[ ] First-run / empty-org path designed (not just the pre-seeded/demo path)
[ ] Provenance & honesty: results show source, timestamp, and "why" where we claim trusted/cited memory
```

The cheapest enforcement is the simplest: **before calling a user-facing task
done, one person walks the flow from a zero state as a new user would** — fresh
org, nothing connected — and confirms they reach value. The connector gap would
not have survived that walk.

## When to reach for a PM skill

The `pm-skills` marketplace is installed (user scope). Use the framework that
matches the moment instead of reasoning from scratch:

| Situation | Skill / command | What it gives you |
|---|---|---|
| "Does the UI do what it claims?" — auditing a shipped flow | `intended-vs-implemented` (pm-ai-shipping) | The intent-vs-code gap method; cite both sides of every gap. |
| Designing or debugging a multi-step flow (onboarding, connect→value) | `customer-journey-map` (pm-market-research) | Stage-by-stage map of actions, emotions, pain points, drop-off. |
| Pinning down what a user actually wants from a feature | `job-stories` (pm-execution) | "When [situation], I want [motivation], so I can [outcome]." |
| Pressure-testing a plan before building | `pre-mortem` / `strategy-red-team` (pm-execution) | Surfaces the failure we'd otherwise ship into. |
| Writing the spec for a real feature | `create-prd` (pm-execution) | 8-section PRD; forces the states and edge cases up front. |
| Choosing what to fix first | `prioritization-frameworks` (pm-execution) | RICE/ICE and 7 others, with formulas. |

Force-load any skill with `/<skill-name>` if it doesn't auto-trigger.

## The one-line test

Before shipping anything a user touches, ask:

> **If a real buyer clicked exactly this, starting from nothing, would the
> product do what the screen just promised — or would they have to already know
> how it works?**

If the answer is "they'd have to know," it isn't done.

---

### Related

- [07-quality-gates.md](07-quality-gates.md) — the code gates this complements
- [MVP-GAP.md §8](MVP-GAP.md) — the original UX/trust gap list (this doc operationalizes it)
- [01-product-spec.md](01-product-spec.md) — FR-2.2 (backfill + incremental sync), FR-2.4 (connector health/last-sync surfacing)
