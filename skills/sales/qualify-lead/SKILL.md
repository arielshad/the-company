---
name: qualify-lead
owner: sales-ops
department: sales
version: 0.1.0
status: draft
source: github
approvalRequired: false
allowedRoles: [member, builder, admin, agent]
requiredTools: [brain.search, crm.update, notify.slack]
---

# Skill: Qualify Lead

Assess an inbound lead against the company's ICP (ideal customer profile) using
company memory, score it, and route it — updating the CRM and notifying the
right channel. Portable, versioned package per `docs/03-data-models.md §2`.

## When to use
A new lead arrives (form fill, email, event). Run this skill to decide whether
it is sales-ready, nurture, or disqualify — with a cited rationale.

## Inputs
See `tools.json` / `inputSchema`: `{ name, company, email, source, notes? }`.

## Behavior
1. `brain.search` for prior interactions, account context, and ICP definition.
2. Score against ICP dimensions (fit, intent, budget signal, timing).
3. Decide: `sales_ready | nurture | disqualify` with confidence + rationale.
4. `crm.update` the lead record with score + stage.
5. `notify.slack` the owning channel; @mention an owner if `sales_ready`.

## Outputs
`{ decision, score (0..1), confidence (0..1), rationale, citations[] }`.

## Guardrails
- Never invent account facts; every claim cites a memory source (eval:
  `source_coverage`).
- If confidence < 0.6, route to `nurture` rather than `disqualify`.
- No external email is sent by this skill (CRM + Slack only).
