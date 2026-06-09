import { z } from "zod";
import { PermissionPolicy, MemoryWritePolicy, EvalPolicy } from "@companyos/schemas";

/**
 * CompanyOS Workflow DSL (docs/03-data-models.md §6).
 * The canvas compiles to this DSL; the DSL — not the canvas — is the source of
 * truth, validated against the invariants below and executed by workflow-engine.
 */

export const NODE_TYPES = [
  "trigger",
  "brain_search",
  "agent",
  "tool",
  "skill",
  "condition",
  "loop",
  "approval",
  "memory_write",
  "task",
  "eval",
  "notify",
  "end"
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const TRIGGER_KINDS = [
  "manual",
  "schedule",
  "webhook",
  "email",
  "calendar",
  "zoom_transcript",
  "slack_event",
  "github_pr",
  "jira_issue"
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Node types that produce an external/durable effect (governance-relevant). */
export const EXTERNAL_EFFECT_NODES: NodeType[] = [
  "tool",
  "task",
  "notify",
  "memory_write"
];

/**
 * Outbound-effect nodes that must be gated by an eval when evalPolicy.gate=block
 * (invariant 5). Generic `tool` nodes are excluded: they may be reads/transforms
 * and are independently authorized at the gateway on every call.
 */
export const GATED_EFFECT_NODES: NodeType[] = ["task", "notify", "memory_write"];

export const WorkflowNode = z
  .object({
    id: z.string().min(1),
    type: z.enum(NODE_TYPES)
  })
  .passthrough();
export type WorkflowNode = z.infer<typeof WorkflowNode> & Record<string, unknown>;

export const WorkflowEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().optional()
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const Workflow = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().nonnegative().default(1),
  state: z.enum(["draft", "published", "archived"]).default("draft"),
  trigger: WorkflowNode,
  nodes: z.array(WorkflowNode).default([]),
  edges: z.array(WorkflowEdge).default([]),
  permissions: PermissionPolicy.default({}),
  memoryWritePolicy: MemoryWritePolicy.default({}),
  evalPolicy: EvalPolicy.default({})
});
export type Workflow = z.infer<typeof Workflow>;

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidateOptions {
  /** Known tool ids the principal may reference (invariant 4). */
  knownTools?: Set<string>;
  /** Known skill ids the principal may reference (invariant 4). */
  knownSkills?: Set<string>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function allNodes(wf: Workflow): WorkflowNode[] {
  return [wf.trigger, ...wf.nodes];
}

function nodeMap(wf: Workflow): Map<string, WorkflowNode> {
  const m = new Map<string, WorkflowNode>();
  for (const n of allNodes(wf)) m.set(n.id, n);
  return m;
}

function outgoing(wf: Workflow, id: string): WorkflowEdge[] {
  return wf.edges.filter((e) => e.from === id);
}

/** Reverse-reachable ancestor ids of `target`, ignoring back-edges into loops. */
function ancestorsOf(wf: Workflow, target: string): Set<string> {
  const result = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of wf.edges) {
      if (e.to === cur && !result.has(e.from)) {
        result.add(e.from);
        stack.push(e.from);
      }
    }
  }
  return result;
}

/** Detect illegal cycles: cycles are only legal when every back-edge targets a `loop` node. */
function hasIllegalCycle(wf: Workflow, nodes: Map<string, WorkflowNode>): boolean {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes.keys()) color.set(id, WHITE);

  let illegal = false;
  const visit = (id: string) => {
    color.set(id, GRAY);
    for (const e of outgoing(wf, id)) {
      const c = color.get(e.to) ?? WHITE;
      if (c === GRAY) {
        // back edge → only legal if it targets a loop node
        if (nodes.get(e.to)?.type !== "loop") illegal = true;
      } else if (c === WHITE) {
        visit(e.to);
      }
    }
    color.set(id, BLACK);
  };
  for (const id of nodes.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  }
  return illegal;
}

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_]+)\.[a-zA-Z0-9_.]+\s*\}\}/g;

/** Extract referenced node ids from any string fields on a node config. */
function templateRefs(node: WorkflowNode): string[] {
  const refs: string[] = [];
  for (const v of Object.values(node)) {
    if (typeof v === "string") {
      for (const m of v.matchAll(TEMPLATE_RE)) refs.push(m[1]!);
    }
  }
  return refs;
}

/**
 * Validate a workflow against DSL invariants 1–6 (docs/03-data-models.md §6).
 */
export function validateWorkflow(
  input: unknown,
  opts: ValidateOptions = {}
): ValidationResult {
  const parsed = Workflow.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({
        code: "schema",
        message: `${i.path.join(".")}: ${i.message}`
      }))
    };
  }
  const wf = parsed.data;
  const errors: ValidationError[] = [];
  const nodes = nodeMap(wf);

  // Unique node ids
  const ids = allNodes(wf).map((n) => n.id);
  if (new Set(ids).size !== ids.length) {
    errors.push({ code: "dup_id", message: "Duplicate node ids" });
  }

  // Invariant 1a: exactly one trigger node
  const triggerCount = allNodes(wf).filter((n) => n.type === "trigger").length;
  if (triggerCount !== 1) {
    errors.push({
      code: "trigger_count",
      message: `Expected exactly one trigger node, found ${triggerCount}`
    });
  }

  // Invariant 1b: at least one reachable end
  const reachable = new Set<string>();
  {
    const stack = [wf.trigger.id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const e of outgoing(wf, cur)) stack.push(e.to);
    }
  }
  const ends = allNodes(wf).filter((n) => n.type === "end");
  if (!ends.some((n) => reachable.has(n.id))) {
    errors.push({ code: "no_end", message: "No reachable `end` node" });
  }

  // Edges must reference existing nodes
  for (const e of wf.edges) {
    if (!nodes.has(e.from))
      errors.push({ code: "edge_from", message: `Edge from unknown node ${e.from}` });
    if (!nodes.has(e.to))
      errors.push({ code: "edge_to", message: `Edge to unknown node ${e.to}` });
  }

  // Invariant 2: acyclic except inside loop nodes
  if (hasIllegalCycle(wf, nodes)) {
    errors.push({ code: "cycle", message: "Illegal cycle (only loop nodes may form cycles)" });
  }

  // Invariant 3: every condition has labelled outgoing branches
  for (const n of allNodes(wf)) {
    if (n.type === "condition") {
      const outs = outgoing(wf, n.id);
      if (outs.length < 2 || outs.some((e) => !e.when)) {
        errors.push({
          code: "condition_branches",
          nodeId: n.id,
          message: `Condition ${n.id} must have >=2 labelled (when) branches`
        });
      }
    }
  }

  // Invariant 4: tool/skill references resolve to known/permitted entities
  for (const n of allNodes(wf)) {
    if (n.type === "tool" && opts.knownTools) {
      const tool = n.tool as string | undefined;
      if (!tool || !opts.knownTools.has(tool)) {
        errors.push({ code: "unknown_tool", nodeId: n.id, message: `Unknown/unpermitted tool: ${tool}` });
      }
    }
    if (n.type === "skill" && opts.knownSkills) {
      const skill = (n.skill ?? n.skillId) as string | undefined;
      if (!skill || !opts.knownSkills.has(skill)) {
        errors.push({ code: "unknown_skill", nodeId: n.id, message: `Unknown/unpermitted skill: ${skill}` });
      }
    }
  }

  // Invariant 5: with evalPolicy.gate=block, external-effect nodes need an eval ancestor
  if (wf.evalPolicy.gate === "block") {
    const evalNodes = new Set(
      allNodes(wf).filter((n) => n.type === "eval").map((n) => n.id)
    );
    for (const n of allNodes(wf)) {
      if (GATED_EFFECT_NODES.includes(n.type) && reachable.has(n.id)) {
        const anc = ancestorsOf(wf, n.id);
        if (![...anc].some((a) => evalNodes.has(a))) {
          errors.push({
            code: "ungated_effect",
            nodeId: n.id,
            message: `External-effect node ${n.id} runs before any eval but evalPolicy.gate=block`
          });
        }
      }
    }
  }

  // Invariant 6: template refs resolve to upstream (ancestor) nodes
  for (const n of allNodes(wf)) {
    const refs = templateRefs(n);
    if (refs.length === 0) continue;
    const anc = ancestorsOf(wf, n.id);
    for (const r of refs) {
      if (r === "input" || r === wf.trigger.id) continue; // trigger input always available
      if (!nodes.has(r)) {
        errors.push({ code: "bad_ref", nodeId: n.id, message: `Template references unknown node {{${r}}}` });
      } else if (!anc.has(r)) {
        errors.push({ code: "non_upstream_ref", nodeId: n.id, message: `Template references non-upstream node {{${r}}}` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/* ---------- Canvas <-> DSL compiler (FR-6.4, round-trip fidelity) ---------- */

export interface CanvasNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}
export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

const WF_META_KEYS = new Set([
  "id",
  "orgId",
  "name",
  "version",
  "state",
  "trigger",
  "nodes",
  "edges",
  "permissions",
  "memoryWritePolicy",
  "evalPolicy"
]);

/** Compile a React-Flow-style canvas into the DSL Workflow. */
export function canvasToDsl(
  canvas: Canvas,
  meta: Pick<Workflow, "id" | "orgId" | "name"> &
    Partial<Pick<Workflow, "version" | "state" | "permissions" | "memoryWritePolicy" | "evalPolicy">>
): Workflow {
  const triggerCanvas = canvas.nodes.find((n) => n.type === "trigger");
  if (!triggerCanvas) throw new Error("canvasToDsl: canvas has no trigger node");

  const toNode = (n: CanvasNode): WorkflowNode =>
    ({ id: n.id, type: n.type, ...n.data }) as WorkflowNode;

  return Workflow.parse({
    ...meta,
    trigger: toNode(triggerCanvas),
    nodes: canvas.nodes.filter((n) => n.type !== "trigger").map(toNode),
    edges: canvas.edges.map((e) => ({
      from: e.source,
      to: e.target,
      ...(e.label ? { when: e.label } : {})
    }))
  });
}

/** Load a DSL Workflow back into a canvas (positions are deterministic/layered). */
export function dslToCanvas(wf: Workflow): Canvas {
  const nodes = [wf.trigger, ...wf.nodes];
  const toData = (n: WorkflowNode): Record<string, unknown> => {
    const { id, type, ...rest } = n;
    void id;
    void type;
    return rest;
  };
  return {
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: n.type,
      position: { x: 0, y: i * 100 },
      data: toData(n)
    })),
    edges: wf.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      ...(e.when ? { label: e.when } : {})
    }))
  };
}

export { WF_META_KEYS };
