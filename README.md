# CompanyOS — The Agent Operating System for Companies

> An **MCP-native company brain** where teams build, govern, and run agentic
> workflows using company knowledge, approved tools, and reusable skills.

CompanyOS is not "AI workflow automation." It is a **company brain with a
managed AI workforce**: connect your knowledge (Notion, Drive, GitHub, Slack,
Zoom, Gmail, Calendar, Jira), build a living memory, define skills and
workflows, and expose everything through MCP so Claude, Cursor, ChatGPT, and
internal agents can act on trusted company context under enterprise governance.

---

## What this repository contains

This repo is the **specification, phased plan, and infrastructure-as-code
scaffolding** for building CompanyOS. It is organized so the build can be
executed by a fleet of subagents (Opus / Sonnet / Haiku) following a strict
**TDD → BDD → e2e, evidence-based** methodology, and deployed to Kubernetes via
an **Argo CD app-of-apps** with sealed secrets and Keycloak SSO.

```
.
├── README.md                      ← you are here (index)
├── docs/
│   ├── 00-vision.md               Product vision & positioning
│   ├── 01-product-spec.md         Full functional specification
│   ├── 02-architecture.md         System & deployment architecture
│   ├── 03-data-models.md          Canonical data models + workflow DSL
│   ├── 04-mcp-and-governance.md   MCP gateway, OpenFGA, approvals, audit
│   ├── 05-development-methodology.md  TDD/BDD/e2e/evidence-based contract
│   ├── 06-subagent-strategy.md    Opus/Sonnet/Haiku assignment rules
│   ├── 07-quality-gates.md        Definition of Done & CI gates
│   ├── phases/                    PHASE-00 … PHASE-08 task breakdowns
│   └── adr/                       Architecture Decision Records
├── tasks/
│   ├── backlog.md                 Master task list (IDs, subagent, gates)
│   └── traceability-matrix.md     Requirement ↔ test ↔ task mapping
└── infra/
    ├── argocd/                    App-of-apps + per-service Application CRs
    ├── base/                      Kustomize bases per microservice
    ├── overlays/                  dev / staging / prod overlays
    ├── platform/                  Keycloak, OpenFGA, Postgres, Redis, etc.
    └── sealed-secrets/            SealedSecret manifests (templates)
```

## Reading order

| If you are… | Read |
| --- | --- |
| New to the product | `docs/00-vision.md` → `docs/01-product-spec.md` |
| An architect | `docs/02-architecture.md` → `docs/03-data-models.md` → `docs/04-mcp-and-governance.md` |
| A builder (human or agent) | `docs/05-development-methodology.md` → `docs/06-subagent-strategy.md` → `tasks/backlog.md` |
| A platform/SRE engineer | `docs/02-architecture.md` → `infra/README.md` |

## Core principles (non-negotiable)

1. **Brain first.** Agents are useless without trusted, permission-aware company context.
2. **MCP-native.** Every external agent accesses the same approved brain and tools.
3. **Governed by default.** Permissions (OpenFGA), approvals, budgets, evals, and audit are first-class, not add-ons.
4. **Evidence-based delivery.** No task is "done" without a failing-then-passing test, BDD scenario, and (where user-facing) an e2e proof artifact.
5. **GitOps everything.** All runtime config is declarative; `infra/` is the source of truth; secrets are sealed.

## Status

This is the **plan-of-record**. Implementation proceeds phase by phase per
`tasks/backlog.md`. Nothing here is built yet — the documents define *what* to
build, *how* to prove it works, and *which model* should build each piece.
