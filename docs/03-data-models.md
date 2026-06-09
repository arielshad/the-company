# 03 — Data Models & Workflow DSL

Canonical models. Implemented as **Zod schemas** in `packages/schemas` (runtime
validation) with generated JSON Schema for the MCP tool catalog and OpenAPI.
All entities carry `orgId`, `createdAt`, `updatedAt`, `createdBy`.

---

## 1. Agent

```ts
type Agent = {
  id: string;
  orgId: string;
  name: string;
  role: "CEO" | "PM" | "Engineer" | "Researcher" | "Sales" | "Support" | string;
  goal: string;
  modelProvider: "anthropic" | "openai" | "google" | "local";
  model?: string;                 // e.g. "claude-opus-4-8"
  budgetMonthlyUsd: number;
  tools: string[];                // tool ids the agent may use
  memoryScopes: string[];         // brain visibility scopes
  approvalPolicy: ApprovalPolicy;
  managerAgentId?: string;        // reporting line → org chart
  status: "active" | "paused" | "archived";
};
```

## 2. Skill

```ts
type Skill = {
  id: string;
  orgId: string;
  name: string;
  owner: string;
  description: string;
  source: "notion" | "github" | "google_drive";
  sourceRef: string;              // page id / repo path / file id
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  requiredTools: string[];
  workflowId?: string;            // optional backing workflow
  approvalRequired: boolean;
  allowedRoles: string[];
  version: string;                // semver
  status: "draft" | "active" | "deprecated";
};
```

Skill package layout (in source / GitHub):

```
skills/<department>/<skill-name>/
  SKILL.md          human + agent instructions
  workflow.yaml     optional backing workflow (DSL)
  tools.json        required tools + scopes
  examples.md       few-shot / usage examples
  evals.yaml        eval cases & thresholds (gates promotion to active)
```

## 3. Workflow

```ts
type Workflow = {
  id: string;
  orgId: string;
  name: string;
  version: number;
  state: "draft" | "published" | "archived";
  trigger: TriggerNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  permissions: PermissionPolicy;
  memoryWritePolicy: MemoryWritePolicy;
  evalPolicy: EvalPolicy;
};
```

## 4. Memory object

```ts
type MemoryObject = {
  id: string;
  orgId: string;
  type: "decision" | "task" | "meeting" | "customer_fact"
      | "project_update" | "risk" | "document";
  title: string;
  content: string;
  source: SourceRef;              // connector + external id + ingestion run
  timestamp: string;
  confidence: number;             // 0..1
  visibility: string[];           // scopes / OpenFGA relations
  relatedPeople: string[];
  relatedProjects: string[];
  supersedes?: string;            // previous memory id (versioning)
  expiresAt?: string;
};
```

## 5. Supporting types

```ts
type ApprovalPolicy = {
  triggers: ("external_send" | "code_change" | "expense"
           | "customer_comms" | "low_confidence")[];
  confidenceThreshold?: number;   // for low_confidence
  approvers: string[];            // user/group/role ids
  escalateAfterMinutes?: number;
  onTimeout: "reject" | "escalate" | "auto_approve";
};

type PermissionPolicy = {
  runAs: "user" | "agent" | "service";
  requiredRelations: string[];    // OpenFGA relations needed to run
};

type MemoryWritePolicy = {
  allowedTypes: MemoryObject["type"][];
  minConfidence: number;
  requireApprovalBelow?: number;
};

type EvalPolicy = {
  evals: string[];                // eval ids to run
  gate: "advisory" | "block";     // block external effects on fail
  thresholds: Record<string, number>;
};

type SourceRef = {
  connector: string;              // "zoom" | "notion" | "github" | ...
  externalId: string;
  ingestionRunId?: string;
  url?: string;
};
```

---

## 6. Workflow DSL

The visual canvas compiles to this declarative DSL (YAML/JSON). The DSL — not
the canvas — is the source of truth, versioned and executed by the engine.
Defined and validated in `packages/dsl`.

### Node types

| Node | Purpose |
| --- | --- |
| `trigger` | Entry: manual, schedule, webhook, email, calendar, zoom_transcript, slack_event, github_pr, jira_issue |
| `brain_search` | Query company memory/docs/meetings/decisions/people/projects |
| `agent` | Role-based LLM agent with goal, tools, memory, budget, model, policy |
| `tool` | Call an approved MCP tool (GitHub, Notion, Drive, Gmail, Calendar, Jira, Slack, browser, internal API) |
| `skill` | Invoke a reusable company skill |
| `condition` | If/else on extracted facts, confidence, status, approval, cost, priority |
| `loop` | Retry / research-until-confidence / iterate over a list |
| `approval` | Human review before external send/code/expense/customer comms |
| `memory_write` | Persist decision/task/insight/customer fact/summary/update |
| `task` | Create ticket, assign owner, schedule follow-up, update CRM, write doc |
| `eval` | Quality/factuality/policy/tone/source-coverage/hallucination check |
| `notify` | Slack/email/Linear/Jira/Notion update |
| `end` | Return result, save artifact, publish output |

### Example DSL — "Zoom transcript → company brain"

```yaml
id: wf_zoom_to_brain
name: Zoom transcript to company brain
version: 3
state: published
trigger:
  id: t1
  type: trigger
  trigger: zoom_transcript          # webhook from Zoom connector
nodes:
  - id: clean
    type: tool
    tool: text.clean_transcript
  - id: extract
    type: agent
    agent: { role: Researcher, model: claude-sonnet-4-6, budgetUsd: 0.50 }
    goal: Extract summary, decisions, action items, risks, customer facts, project updates
    outputSchema: ExtractionResult
  - id: context
    type: brain_search
    query: "{{extract.project}} {{extract.customer}}"
    topK: 8
  - id: decide
    type: condition
    when: "extract.confidence < 0.8 || extract.customerSensitive == true"
  - id: approve
    type: approval
    policy: { approvers: [team:ops], escalateAfterMinutes: 120, onTimeout: escalate }
  - id: write
    type: memory_write
    policy: { allowedTypes: [decision, task, meeting, customer_fact, project_update, risk], minConfidence: 0.6 }
  - id: tasks
    type: task
    action: create_tickets
    target: jira
  - id: slack
    type: notify
    channel: slack
    to: "#team-updates"
  - id: done
    type: end
edges:
  - { from: t1, to: clean }
  - { from: clean, to: extract }
  - { from: extract, to: context }
  - { from: context, to: decide }
  - { from: decide, to: approve, when: "true" }    # branch: needs approval
  - { from: decide, to: write, when: "false" }      # branch: auto
  - { from: approve, to: write }
  - { from: write, to: tasks }
  - { from: tasks, to: slack }
  - { from: slack, to: done }
permissions: { runAs: agent, requiredRelations: [brain#writer] }
memoryWritePolicy: { allowedTypes: [decision, task, meeting, customer_fact, project_update, risk], minConfidence: 0.6, requireApprovalBelow: 0.8 }
evalPolicy: { evals: [factuality, source_coverage], gate: block, thresholds: { factuality: 0.8, source_coverage: 0.7 } }
```

### DSL invariants (validated by `packages/dsl`)

1. Exactly one `trigger`; at least one reachable `end`.
2. The graph is acyclic except inside `loop` nodes.
3. Every `condition` has labelled outgoing branches.
4. Every `tool`/`skill` reference resolves to a registered, permitted entity.
5. Every external-effect node downstream of an `evalPolicy.gate: block` must be reachable only after the eval passes.
6. Template references (`{{node.field}}`) resolve against upstream node output schemas.

## 7. Audit record

```ts
type AuditRecord = {
  id: string;
  orgId: string;
  ts: string;                     // append-only, immutable
  actor: { type: "user" | "agent" | "service"; id: string };
  action: string;                 // "tool.call" | "memory.write" | "approval.decide" | "budget.exceeded" | ...
  resource: { type: string; id: string };
  traceId: string;
  costUsd?: number;
  decision?: "allow" | "deny";    // authz outcome
  metadata: Record<string, unknown>;
};
```
