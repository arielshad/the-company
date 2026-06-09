# 00 — Vision & Positioning

## The one-liner

> **The agent operating system for companies** — a company brain with managed AI workers.

## The problem

Companies are adopting AI agents (Claude, Cursor, ChatGPT, internal bots) but
each agent is blind to company context, ungoverned, and disconnected from how
work actually flows. Today you get:

- Chatbots that hallucinate because they lack trusted company memory.
- Per-tool integrations that leak permissions and have no audit trail.
- "Automation" tools (Zapier/n8n/Make) that move data but cannot reason, manage
  budgets, or be held accountable like a worker.
- No single source of truth that updates itself from real work (meetings,
  emails, PRs, tickets).

## The product

CompanyOS combines four categories that exist separately today into one
enterprise-grade product:

| Category | Today's tools | CompanyOS layer |
| --- | --- | --- |
| Brain / RAG | Onyx, Dify, Langflow | **Company Brain** |
| Agent runtime | LangGraph, VoltAgent, CrewAI | **Workflow Engine** |
| Builder UI | Dify, Flowise, Open Agent Builder | **Workflow Builder** |
| Agent OS / management | Paperclip, AionUi | **Agent Registry + Governance** |

It lets a company:

1. **Connect knowledge** — Notion, Google Drive, GitHub, Slack, Zoom, Gmail, Calendar, Jira.
2. **Build a living brain** — search, memory, decisions, people, projects, timelines, meetings, docs.
3. **Define skills & workflows** — SOPs, playbooks, prompts, agent instructions, approval rules.
4. **Build agentic workflows visually** — drag-and-drop agents, tools, memory, conditions, loops, approvals, triggers.
5. **Expose everything through MCP** — Claude/Cursor/ChatGPT/Claude Code/internal agents reach the approved brain and tools.
6. **Manage agents like employees** — roles, goals, budgets, permissions, task queues, reporting lines, evaluation, audit trail.

## Positioning — what we are NOT

- **Not** "AI workflow automation" (that reads as n8n/Zapier/Make/Dify/Flowise).
- **Not** a generic chatbot or a single agent.
- **Not** a replacement for Claude Code / Cursor — those become **clients** of CompanyOS.

We **are** *"Paperclip for real companies, connected to their internal
knowledge, permissions, workflows, and MCP tools."*

## Where we beat Paperclip-style products

1. **Company brain first** — agents act on trusted, permission-aware context.
2. **MCP-native** — every external agent uses the same governed brain and tools.
3. **Configurable source of truth** — Notion now, GitHub-backed skill packages later, Drive optional.
4. **Enterprise governance** — permissions, approvals, budgets, audit logs, evals.
5. **Trigger-updated memory** — the brain updates from real work (meetings, emails, calendars, tickets, PRs).
6. **Workflow builder** — ops/business users build workflows without code.

## Reference products to borrow from

| Source | Borrow |
| --- | --- |
| Paperclip | Agent org chart, budgets, goals, approval, dashboard-first UX |
| Open Agent Builder | Visual node builder with MCP/tool/approval nodes |
| Dify | AI app/workflow packaging & observability |
| Flowise | Visual AI graph UX |
| Onyx | Enterprise brain/search |
| Graphiti | Temporal memory graph |

## North-star outcomes

- A new employee (human or agent) can answer "what was decided about X, by whom,
  and why" in one query, with sources and timestamps.
- A meeting transcript becomes structured memory + tasks + notifications within
  minutes, with human approval only where policy requires it.
- An admin can see every agent's cost, actions, and approvals this month, and
  revoke a permission in one click — with a full audit trail.
