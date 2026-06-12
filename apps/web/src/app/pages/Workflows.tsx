import { useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CheckCircle2, AlertTriangle, PlayCircle, Code2, Plus, Trash2, MousePointer2 } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { pushToast, markDone } from "../lib/store.js";
import { useApi } from "../lib/hooks.js";
import { api, type RunRecord } from "../lib/api.js";
import { NODE_TYPES, TRIGGER_KINDS, validateWorkflow, type Workflow } from "@companyos/dsl";

/** Flagship workflow id — matched first, then falls back to the first workflow. */
const FLAGSHIP_ID = "wf_zoom_to_brain";

/** Sample trigger data mirroring a Zoom transcript event (built inline, no connector). */
const SAMPLE: Record<string, unknown> = {
  meetingId: "zoom-builder-1",
  topic: "Acme x Globex — Q3 renewal",
  transcript:
    "Alice: Decision: we will prioritize SSO for the August release.\nSam: Our budget for expansion is approved at 250 seats.\nAlice: Risk - SSO slipping past August may delay Globex expansion.\nAlice: Action item - Bob to scope SSO and open a Jira ticket."
};

interface NodeData extends Record<string, unknown> {
  kind: string;
  label: string;
  config: Record<string, unknown>;
}

type FieldKind = "text" | "number" | "select" | "json";
interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
}

const MEMORY_TYPES = ["decision", "task", "meeting", "customer_fact", "project_update", "risk", "document"] as const;

/** Per-node-type config schema rendered in the inspector. */
const FIELDS: Record<string, FieldDef[]> = {
  trigger: [{ key: "trigger", label: "Trigger kind", kind: "select", options: TRIGGER_KINDS }],
  brain_search: [
    { key: "query", label: "Query (supports {{node.field}})", kind: "text" },
    { key: "topK", label: "Top K results", kind: "number" }
  ],
  agent: [
    { key: "handler", label: "Agent handler", kind: "text" },
    { key: "agent", label: "Agent config (role / model / budgetUsd)", kind: "json" }
  ],
  tool: [{ key: "tool", label: "Tool id", kind: "text" }],
  skill: [{ key: "skill", label: "Skill id", kind: "text" }],
  condition: [{ key: "predicate", label: "Predicate — any/all of {field, op, value}", kind: "json" }],
  loop: [{ key: "maxIterations", label: "Max iterations", kind: "number" }],
  approval: [{ key: "policy", label: "Approval policy (approvers / onTimeout)", kind: "json" }],
  eval: [{ key: "policy", label: "Eval policy (evals / gate / thresholds)", kind: "json" }],
  memory_write: [{ key: "memoryType", label: "Memory type", kind: "select", options: MEMORY_TYPES }],
  task: [{ key: "action", label: "Task action", kind: "text" }],
  notify: [{ key: "channel", label: "Channel", kind: "text" }],
  end: []
};

function WFNode({ data, selected }: NodeProps) {
  const d = data as NodeData;
  return (
    <div className={`wf-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-type">{d.kind}</div>
      <div style={{ fontWeight: 600 }}>{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { company: WFNode };

function layout(wf: Workflow): { nodes: Node[]; edges: Edge[] } {
  const all = [wf.trigger, ...wf.nodes];
  const depth = new Map<string, number>();
  depth.set(wf.trigger.id, 0);
  const queue = [wf.trigger.id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of wf.edges.filter((x) => x.from === cur)) {
      const nd = (depth.get(cur) ?? 0) + 1;
      if (!depth.has(e.to) || nd > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, nd);
        queue.push(e.to);
      }
    }
  }
  const lane: Record<number, number> = {};
  const nodes: Node[] = all.map((n) => {
    const { id, type, ...config } = n as { id: string; type: string } & Record<string, unknown>;
    const d = depth.get(id) ?? 0;
    const y = (lane[d] = (lane[d] ?? 0) + 1);
    return { id, type: "company", position: { x: d * 210 + 30, y: y * 96 - 40 }, data: { kind: type, label: id, config } as NodeData };
  });
  const edges: Edge[] = wf.edges.map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to, label: e.when, animated: true }));
  return { nodes, edges };
}

/** JSON editor that only commits when the text parses. */
function JsonField({ value, onCommit }: { value: unknown; onCommit: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState(false);
  const handle = (t: string) => {
    setText(t);
    try {
      onCommit(JSON.parse(t));
      setErr(false);
    } catch {
      setErr(true);
    }
  };
  return (
    <>
      <textarea className={`textarea json-field ${err ? "invalid" : ""}`} value={text} onChange={(e) => handle(e.target.value)} />
      {err && <div className="faint" style={{ color: "var(--danger)", fontSize: 11 }}>Invalid JSON — not saved</div>}
    </>
  );
}

function statusBadge(status: string): string {
  if (status === "completed" || status === "succeeded") return "badge green";
  if (status === "paused" || status === "running" || status === "pending") return "badge amber";
  if (status === "failed" || status === "rejected") return "badge red";
  return "badge blue";
}

/** Compact recent-runs panel; refetched after a run is triggered. */
function RecentRuns({ runs, loading, error }: { runs?: RunRecord[]; loading: boolean; error?: string }) {
  return (
    <div className="card mt-3">
      <div className="stat-label mb-2">Recent runs</div>
      {loading && !runs ? (
        <div className="faint" style={{ fontSize: 12.5 }}>Loading…</div>
      ) : error ? (
        <div className="faint" style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</div>
      ) : runs && runs.length > 0 ? (
        <div className="list">
          {runs.map((r) => (
            <div key={r.id} className="list-item row">
              <span className="mono" style={{ fontSize: 12 }}>{r.id}</span>
              <span className={statusBadge(r.status)}>{r.status}</span>
              <div className="spacer" />
              <span className="faint" style={{ fontSize: 12 }}>{r.startedAt ?? "—"}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="faint" style={{ fontSize: 12.5 }}>No runs yet — click Run to trigger the flagship workflow.</p>
      )}
    </div>
  );
}

/** Canvas builder rendered once the workflow has loaded. */
function Builder({ wf }: { wf: Workflow }) {
  const initial = useMemo(() => layout(wf), [wf]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [result, setResult] = useState<{ valid: boolean; errors: { code: string; message: string }[] } | null>(null);
  const [showDsl, setShowDsl] = useState(false);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const [running, setRunning] = useState(false);

  const runsState = useApi(() => api.runs(), []);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)), [setEdges]);

  const addNode = (kind: string) => {
    const id = `${kind}_${n + 1}`;
    setN(n + 1);
    const defaults: Record<string, unknown> = kind === "trigger" ? { trigger: "manual" } : {};
    setNodes((nds) => [...nds, { id, type: "company", position: { x: 120 + (n % 4) * 60, y: 40 + (n % 6) * 70 }, data: { kind, label: id, config: defaults } as NodeData }]);
    setSelNode(id);
    setSelEdge(null);
  };

  const updateConfig = (nodeId: string, key: string, value: unknown) =>
    setNodes((nds) => nds.map((nd) => (nd.id === nodeId ? { ...nd, data: { ...(nd.data as NodeData), config: { ...(nd.data as NodeData).config, [key]: value } } } : nd)));

  const deleteNode = (nodeId: string) => {
    setNodes((nds) => nds.filter((nd) => nd.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelNode(null);
  };

  const updateEdgeLabel = (edgeId: string, label: string) =>
    setEdges((eds) => eds.map((e) => (e.id === edgeId ? { ...e, label: label || undefined } : e)));

  const compiled = useMemo<Workflow>(() => {
    const toNode = (rn: Node) => {
      const d = rn.data as NodeData;
      return { id: rn.id, type: d.kind, ...d.config };
    };
    const triggerNode = nodes.find((x) => (x.data as NodeData).kind === "trigger");
    return {
      ...wf,
      trigger: (triggerNode ? toNode(triggerNode) : wf.trigger) as Workflow["trigger"],
      nodes: nodes.filter((x) => (x.data as NodeData).kind !== "trigger").map(toNode) as Workflow["nodes"],
      edges: edges.map((e) => ({ from: e.source, to: e.target, ...(e.label ? { when: String(e.label) } : {}) }))
    };
  }, [nodes, edges, wf]);

  const validate = () => {
    const r = validateWorkflow(compiled);
    setResult(r);
    pushToast(r.valid ? "Workflow is valid ✓" : `${r.errors.length} validation issue(s)`, r.valid ? "ok" : "error");
  };

  const run = async () => {
    setRunning(true);
    try {
      const res = (await api.runWorkflow(wf.id, SAMPLE)) as { runId?: string; status?: string };
      markDone("ran_workflow");
      if (res.status === "paused") pushToast("Run paused — approval required. Open Governance to approve.");
      else pushToast(`Run ${res.status ?? "started"}`);
      runsState.refetch();
    } catch (e) {
      pushToast(`Run failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setRunning(false);
    }
  };

  const selectedNode = nodes.find((x) => x.id === selNode);
  const selectedEdge = edges.find((e) => e.id === selEdge);

  return (
    <>
      <div className="row mb-3">
        <span className="badge blue">{wf.name}</span>
        <span className="faint" style={{ fontSize: 12 }}>v{wf.version} · {wf.state}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setShowDsl((s) => !s)}><Code2 size={15} /> {showDsl ? "Hide" : "View"} DSL</button>
        <button className="btn" onClick={validate}><CheckCircle2 size={15} /> Validate</button>
        <button className="btn primary" onClick={run} disabled={running}><PlayCircle size={15} /> {running ? "Running…" : "Run"}</button>
      </div>

      {result && (
        <div className="card mb-3" style={{ borderColor: result.valid ? "rgba(52,211,154,0.4)" : "rgba(246,104,94,0.4)" }}>
          {result.valid ? (
            <div className="row" style={{ color: "var(--accent)" }}><CheckCircle2 size={16} /> Valid — compiles to {compiled.nodes.length + 1} nodes, {compiled.edges.length} edges.</div>
          ) : (
            <div>
              <div className="row" style={{ color: "var(--danger)" }}><AlertTriangle size={16} /> Validation issues</div>
              <ul className="mt-2" style={{ margin: 0, paddingLeft: 18 }}>
                {result.errors.map((e, i) => (
                  <li key={i} className="faint" style={{ fontSize: 12.5 }}><span className="mono">{e.code}</span> — {e.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="builder">
        <div className="palette">
          <div className="stat-label mb-2">Node palette</div>
          {NODE_TYPES.map((t) => (
            <div key={t} className="palette-node" onClick={() => addNode(t)}>
              <Plus size={13} /> {t}
            </div>
          ))}
          <p className="faint mt-3" style={{ fontSize: 11.5 }}>Click to add a node, drag between handles to connect, click a node or edge to configure it.</p>
        </div>

        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelNode(node.id); setSelEdge(null); }}
            onEdgeClick={(_, edge) => { setSelEdge(edge.id); setSelNode(null); }}
            onPaneClick={() => { setSelNode(null); setSelEdge(null); }}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#2f3a4f" gap={18} />
            <Controls />
            <MiniMap pannable zoomable style={{ background: "#0e131d" }} maskColor="rgba(0,0,0,0.5)" nodeColor="#6d8bff" />
          </ReactFlow>
        </div>

        <div className="inspector">
          {selectedNode ? (
            <div>
              <div className="row mb-3">
                <div>
                  <div className="card-title">{(selectedNode.data as NodeData).kind}</div>
                  <div className="mono faint" style={{ fontSize: 11 }}>{selectedNode.id}</div>
                </div>
                <div className="spacer" />
                <button className="btn ghost sm danger" onClick={() => deleteNode(selectedNode.id)} aria-label="Delete node"><Trash2 size={14} /></button>
              </div>
              {(FIELDS[(selectedNode.data as NodeData).kind] ?? []).map((f) => {
                const cfg = (selectedNode.data as NodeData).config;
                if (f.kind === "json") {
                  return (
                    <div className="field" key={f.key}>
                      <label className="label">{f.label}</label>
                      <JsonField key={`${selectedNode.id}-${f.key}`} value={cfg[f.key]} onCommit={(v) => updateConfig(selectedNode.id, f.key, v)} />
                    </div>
                  );
                }
                if (f.kind === "select") {
                  return (
                    <div className="field" key={f.key}>
                      <label className="label">{f.label}</label>
                      <select className="select" value={String(cfg[f.key] ?? "")} onChange={(e) => updateConfig(selectedNode.id, f.key, e.target.value)}>
                        <option value="">—</option>
                        {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  );
                }
                return (
                  <div className="field" key={f.key}>
                    <label className="label">{f.label}</label>
                    <input
                      className="input"
                      type={f.kind === "number" ? "number" : "text"}
                      value={String(cfg[f.key] ?? "")}
                      onChange={(e) => updateConfig(selectedNode.id, f.key, f.kind === "number" ? Number(e.target.value) : e.target.value)}
                    />
                  </div>
                );
              })}
              {(FIELDS[(selectedNode.data as NodeData).kind] ?? []).length === 0 && <p className="faint" style={{ fontSize: 12.5 }}>This node has no configuration.</p>}
            </div>
          ) : selectedEdge ? (
            <div>
              <div className="card-title mb-3">Edge</div>
              <div className="mono faint mb-3" style={{ fontSize: 11 }}>{selectedEdge.source} → {selectedEdge.target}</div>
              <div className="field">
                <label className="label">Branch label (when)</label>
                <input className="input" placeholder="e.g. true / false / retry / exit" value={String(selectedEdge.label ?? "")} onChange={(e) => updateEdgeLabel(selectedEdge.id, e.target.value)} />
                <p className="faint mt-2" style={{ fontSize: 11 }}>Condition nodes need two labelled branches (true/false). Loops use retry/exit.</p>
              </div>
            </div>
          ) : (
            <div className="empty" style={{ padding: "40px 8px" }}>
              <MousePointer2 size={26} />
              <div style={{ fontWeight: 600, color: "var(--text-dim)" }}>Nothing selected</div>
              <div style={{ fontSize: 12.5 }}>Click a node or edge on the canvas to edit its configuration.</div>
            </div>
          )}
        </div>
      </div>

      {showDsl && (
        <div className="mt-3">
          <div className="stat-label mb-2">Compiled workflow DSL</div>
          <pre className="codeblock">{JSON.stringify(compiled, null, 2)}</pre>
        </div>
      )}

      <RecentRuns runs={runsState.data} loading={runsState.loading} error={runsState.error} />

      <p className="faint mt-3" style={{ fontSize: 12.5 }}>
        Running triggers the workflow through the MCP gateway as the ops agent; customer-sensitive runs pause for human{" "}
        <Link to="/governance" style={{ color: "var(--brand)" }}>approval</Link>.
      </p>
    </>
  );
}

export function WorkflowsPage() {
  const { data: workflows, loading, error } = useApi(() => api.workflows(), []);

  // The list returns full DSL workflows; pick the flagship by id, else the first.
  const wf = useMemo(() => {
    if (!workflows) return undefined;
    return (workflows.find((w) => w.id === FLAGSHIP_ID) ?? workflows[0]) as Workflow | undefined;
  }, [workflows]);

  return (
    <Shell title="Workflow builder" sub="Compose agentic workflows on a canvas — compiled to a validated, versioned spec">
      {loading && !workflows ? (
        <div className="faint" style={{ fontSize: 13 }}>Loading…</div>
      ) : error ? (
        <div className="card" style={{ borderColor: "rgba(246,104,94,0.4)" }}>
          <div className="row" style={{ color: "var(--danger)" }}><AlertTriangle size={16} /> Failed to load workflows — {error}</div>
        </div>
      ) : wf ? (
        <Builder wf={wf} />
      ) : (
        <div className="empty" style={{ padding: "40px 8px" }}>
          <MousePointer2 size={26} />
          <div style={{ fontWeight: 600, color: "var(--text-dim)" }}>No workflows yet</div>
          <div style={{ fontSize: 12.5 }}>Publish a workflow to start composing on the canvas.</div>
        </div>
      )}
    </Shell>
  );
}