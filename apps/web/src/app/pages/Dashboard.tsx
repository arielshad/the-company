import { Link } from "react-router-dom";
import { Brain, Bot, Plug, ShieldCheck, CheckCircle2, Circle, ArrowRight, Activity } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { Stat, timeAgo } from "../components/ui.js";
import { useOnboarding, startOnboarding } from "../lib/store.js";
import { useApi } from "../lib/hooks.js";
import { api } from "../lib/api.js";

const CHECKLIST = [
  { key: "connected_source", label: "Connect a knowledge source", to: "/integrations", icon: Plug },
  { key: "searched_brain", label: "Ask the company brain a question", to: "/brain", icon: Brain },
  { key: "created_agent", label: "Create an AI agent", to: "/agents", icon: Bot },
  { key: "ran_workflow", label: "Run a governed workflow", to: "/workflows", icon: ShieldCheck }
];

export function Dashboard() {
  const onb = useOnboarding();
  const doneCount = CHECKLIST.filter((c) => onb.done[c.key]).length;
  const pct = Math.round((doneCount / CHECKLIST.length) * 100);

  const agents = useApi(() => api.agents(), []);
  const connectors = useApi(() => api.connectors(), []);
  const approvals = useApi(() => api.approvals(), []);
  const auditState = useApi(() => api.audit(), []);

  const activeAgents = agents.data?.filter((a) => a.status === "active").length ?? 0;
  const connectedSources = connectors.data?.filter((c) => c.connected).length ?? 0;
  const totalSources = connectors.data?.length ?? 0;
  const pendingApprovals = approvals.data?.filter((a) => a.status === "pending").length ?? 0;
  const brainMemories = auditState.data?.audit.length ?? 0;

  const loading = agents.loading || connectors.loading || approvals.loading || auditState.loading;
  const error = agents.error || connectors.error || approvals.error || auditState.error;

  const recent = auditState.data?.audit.slice(0, 6) ?? [];

  return (
    <Shell title="Dashboard" sub="Welcome back, Alice — here's your company at a glance">
      {error && (
        <div className="card mb-4" style={{ borderColor: "var(--red)" }}>
          <div style={{ fontSize: 13, color: "var(--red)" }}>Couldn't load dashboard: {error}</div>
        </div>
      )}

      <div className="grid cols-4 mb-4">
        <Stat label="Brain memories" value={loading ? <span className="faint">Loading…</span> : brainMemories} hint="searchable, permission-aware" />
        <Stat label="Active agents" value={loading ? <span className="faint">Loading…</span> : activeAgents} hint="managed AI workers" />
        <Stat label="Connected sources" value={loading ? <span className="faint">Loading…</span> : `${connectedSources}/${totalSources}`} hint="knowledge connectors" />
        <Stat label="Pending approvals" value={loading ? <span className="faint">Loading…</span> : pendingApprovals} hint="awaiting a human" />
      </div>

      {doneCount < CHECKLIST.length && (
        <div className="card mb-4">
          <div className="row">
            <div>
              <div className="card-title">Getting started</div>
              <div className="card-sub">Try each part of CompanyOS — {doneCount} of {CHECKLIST.length} done</div>
            </div>
            <div className="spacer" />
            <button className="btn ghost sm" onClick={() => startOnboarding()}>Replay tour</button>
          </div>
          <div className="progress mt-3" style={{ marginBottom: 14 }}>
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="grid cols-2">
            {CHECKLIST.map((c) => {
              const done = !!onb.done[c.key];
              return (
                <Link key={c.key} to={c.to} className="list-item" style={{ borderBottom: "none" }}>
                  {done ? <CheckCircle2 size={18} color="var(--accent)" /> : <Circle size={18} color="var(--text-faint)" />}
                  <c.icon size={16} color="var(--text-dim)" />
                  <span style={{ fontSize: 13.5, color: done ? "var(--text-faint)" : "var(--text)", textDecoration: done ? "line-through" : "none" }}>
                    {c.label}
                  </span>
                  {!done && <ArrowRight size={14} style={{ marginLeft: "auto" }} className="faint" />}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title mb-3">Jump in</div>
          <div className="col" style={{ gap: 8 }}>
            <Link to="/brain" className="btn ghost" style={{ justifyContent: "flex-start" }}><Brain size={16} /> Ask the company brain</Link>
            <Link to="/workflows" className="btn ghost" style={{ justifyContent: "flex-start" }}><ShieldCheck size={16} /> Open the workflow builder</Link>
            <Link to="/agents" className="btn ghost" style={{ justifyContent: "flex-start" }}><Bot size={16} /> Manage your agents</Link>
            <Link to="/integrations" className="btn ghost" style={{ justifyContent: "flex-start" }}><Plug size={16} /> Connect a source</Link>
          </div>
        </div>

        <div className="card">
          <div className="row mb-3">
            <Activity size={16} color="var(--brand)" />
            <div className="card-title">Recent activity</div>
          </div>
          {auditState.loading ? (
            <div className="faint" style={{ fontSize: 13 }}>Loading…</div>
          ) : recent.length === 0 ? (
            <div className="faint" style={{ fontSize: 13 }}>No activity yet — run a workflow to see the audit trail.</div>
          ) : (
            <div className="list">
              {recent.map((r) => (
                <div className="list-item" key={r.id}>
                  <span className={`badge-dot ${r.decision === "deny" ? "red" : r.decision === "allow" ? "green" : ""}`} />
                  <div style={{ fontSize: 13 }}>
                    <span className="mono">{r.action}</span>
                    <div className="faint" style={{ fontSize: 11.5 }}>{r.actor.id} · {timeAgo(r.ts)}</div>
                  </div>
                  {r.costUsd != null && <span className="badge" style={{ marginLeft: "auto" }}>${r.costUsd.toFixed(4)}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
