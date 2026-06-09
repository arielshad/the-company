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
import { CheckCircle2, AlertTriangle, PlayCircle, Code2, Plus } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { usePlatform, mutate, pushToast, markDone } from "../lib/store.js";
import { NODE_TYPES, validateWorkflow, type Workflow } from "@companyos/dsl";
import { ZoomConnector } from "@companyos/connectors";

const SAMPLE = {
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

function WFNode({ data }: NodeProps) {
  const d = data as NodeData;
  return (
    <div className="wf-node">
      <Handle type="target" position={Position.Left} />
      <div className="wf-type">{d.kind}</div>
      <div style={{ fontWeight: 600 }}>{d.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { company: WFNode };

/** Layered left→right layout from the DSL graph. */
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
    return {
      id,
      type: "company",
      position: { x: d * 210 + 30, y: y * 96 - 40 },
      data: { kind: type, label: id, config } as NodeData
    };
  });
  const edges: Edge[] = wf.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    label: e.when,
    animated: true
  }));
  return { nodes, edges };
}

export function WorkflowsPage() {
  const p = usePlatform();
  const wf = p.workflows.get("wf_zoom_to_brain")!;
  const initial = useMemo(() => layout(wf), [wf]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [result, setResult] = useState<{ valid: boolean; errors: { code: string; message: string }[] } | null>(null);
  const [showDsl, setShowDsl] = useState(false);
  const [n, setN] = useState(0);

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)), [setEdges]);

  const addNode = (kind: string) => {
    const id = `${kind}_${n + 1}`;
    setN(n + 1);
    setNodes((nds) => [
      ...nds,
      { id, type: "company", position: { x: 120 + (n % 4) * 60, y: 40 + (n % 6) * 70 }, data: { kind, label: id, config: {} } as NodeData }
    ]);
  };

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
    const ev = new ZoomConnector().handle(p.user.orgId, SAMPLE);
    const res = await mutate(() => p.gateway.callTool(p.opsAgent, "workflow.trigger", { workflowId: wf.id, data: ev.trigger.data }));
    const out = (res as { ok: boolean; result?: { runId: string; status: string }; error?: string });
    markDone("ran_workflow");
    if (!out.ok) {
      pushToast(`Run failed: ${out.error}`, "error");
      return;
    }
    if (out.result?.status === "paused") pushToast("Run paused — approval required. Open Governance to approve.");
    else pushToast(`Run ${out.result?.status}`);
  };

  return (
    <Shell title="Workflow builder" sub="Compose agentic workflows on a canvas — compiled to a validated, versioned spec">
      <div className="row mb-3">
        <span className="badge blue">{wf.name}</span>
        <span className="faint" style={{ fontSize: 12 }}>v{wf.version} · {wf.state}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => setShowDsl((s) => !s)}><Code2 size={15} /> {showDsl ? "Hide" : "View"} DSL</button>
        <button className="btn" onClick={validate}><CheckCircle2 size={15} /> Validate</button>
        <button className="btn primary" onClick={run}><PlayCircle size={15} /> Run</button>
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
          <p className="faint mt-3" style={{ fontSize: 11.5 }}>Click to add a node, then drag between handles to connect. Validate to check the DSL invariants.</p>
        </div>
        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#2f3a4f" gap={18} />
            <Controls />
            <MiniMap pannable zoomable style={{ background: "#0e131d" }} maskColor="rgba(0,0,0,0.5)" nodeColor="#6d8bff" />
          </ReactFlow>
        </div>
      </div>

      {showDsl && (
        <div className="mt-3">
          <div className="stat-label mb-2">Compiled workflow DSL</div>
          <pre className="codeblock">{JSON.stringify(compiled, null, 2)}</pre>
        </div>
      )}

      <p className="faint mt-3" style={{ fontSize: 12.5 }}>
        Running triggers the workflow through the MCP gateway as the ops agent; customer-sensitive runs pause for human{" "}
        <Link to="/governance" style={{ color: "var(--brand)" }}>approval</Link>.
      </p>
    </Shell>
  );
}
