import { useState } from "react";
import { Bot, Plus, Play, Archive } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, Field, EmptyState, Modal } from "../components/ui.js";
import { usePlatform, mutate, pushToast, markDone } from "../lib/store.js";
import type { Agent } from "@companyos/schemas";

interface RunTaskState {
  agent: Agent;
  task: string;
  running: boolean;
}

const ROLE_OPTIONS = ["CEO", "PM", "Engineer", "Researcher", "Sales", "Support"] as const;

function roleBadgeClass(role: string): string {
  switch (role) {
    case "CEO": return "badge blue";
    case "PM": return "badge green";
    case "Engineer": return "badge amber";
    case "Researcher": return "badge";
    case "Sales": return "badge green";
    case "Support": return "badge";
    default: return "badge";
  }
}

export function AgentsPage() {
  const p = usePlatform();
  const orgId = p.user.orgId;

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>("PM");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [saving, setSaving] = useState(false);

  const [runState, setRunState] = useState<RunTaskState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const allAgents = p.agents.list(orgId);
  const agents = allAgents.filter((a) => a.status !== "archived");
  const archivedAgents = allAgents.filter((a) => a.status === "archived");

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await mutate(() =>
        p.agents.create({
          orgId,
          name: name.trim(),
          role,
          goal: goal.trim(),
          budgetMonthlyUsd: budget ? Number(budget) : undefined
        })
      );
      pushToast("Agent created", "ok");
      markDone("created_agent");
      setShowCreate(false);
      setName("");
      setRole("PM");
      setGoal("");
      setBudget("");
    } finally {
      setSaving(false);
    }
  }

  async function handleRunTask() {
    if (!runState || !runState.task.trim()) return;
    setSubmitting(true);
    try {
      const r = await mutate(() => p.agents.runManualTask(runState.agent.id, runState.task));
      if (r.status === "budget_exceeded") {
        pushToast("Budget exceeded — run blocked", "error");
      } else {
        pushToast(`Done ($${r.costUsd.toFixed(4)}): ${r.output}`);
      }
      setRunState(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchive(agent: Agent) {
    await mutate(() => p.agents.archive(agent.id));
    pushToast(`${agent.name} archived`);
  }

  const orgChart = p.agents.orgChart(orgId);
  const managers = orgChart.filter((n) => n.reports.length > 0);

  return (
    <Shell title="Agents" sub="Your AI workforce — managed like employees">
      <PageHeader
        title="Agents"
        sub="Your AI workforce — managed like employees"
        actions={
          <button className="btn primary" onClick={() => setShowCreate(true)}>
            <Plus size={15} /> New agent
          </button>
        }
      />

      {agents.length === 0 && archivedAgents.length === 0 ? (
        <EmptyState
          icon={<Bot size={32} style={{ opacity: 0.35 }} />}
          title="No agents yet"
          sub="Create your first AI agent to start building your workforce."
          action={
            <button className="btn primary" onClick={() => setShowCreate(true)}>
              <Plus size={15} /> New agent
            </button>
          }
        />
      ) : (
        <>
          <div className="grid cols-3">
            {agents.map((agent) => {
              const spent = p.budgetSpent(agent.id);
              const cap = agent.budgetMonthlyUsd;
              const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
              return (
                <div key={agent.id} className="card hover col" style={{ gap: 10 }}>
                  <div className="row" style={{ gap: 10, alignItems: "center" }}>
                    <div className="avatar">{agent.name.charAt(0).toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="card-title" style={{ margin: 0 }}>{agent.name}</div>
                      <span className={roleBadgeClass(agent.role)} style={{ marginTop: 3, display: "inline-block" }}>
                        {agent.role}
                      </span>
                    </div>
                  </div>
                  {agent.goal && (
                    <div className="faint" style={{ fontSize: 13, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {agent.goal}
                    </div>
                  )}
                  <div>
                    <div className="row mb-2" style={{ fontSize: 12, gap: 4 }}>
                      <span className="muted">Budget</span>
                      <div className="spacer" />
                      <span className="mono faint">${spent.toFixed(2)} / ${cap.toFixed(2)}</span>
                    </div>
                    <div className="progress">
                      <div style={{ width: `${pct}%`, background: pct >= 100 ? "var(--red, #e55)" : pct >= 80 ? "var(--amber, #f90)" : "var(--accent, #4a9eff)" }} />
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 2 }}>
                    <button
                      className="btn sm"
                      onClick={() => setRunState({ agent, task: "", running: false })}
                    >
                      <Play size={13} /> Run task
                    </button>
                    <button
                      className="btn ghost sm danger"
                      onClick={() => handleArchive(agent)}
                    >
                      <Archive size={13} /> Archive
                    </button>
                  </div>
                </div>
              );
            })}
            {archivedAgents.map((agent) => (
              <div key={agent.id} className="card col" style={{ gap: 8, opacity: 0.55 }}>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <div className="avatar">{agent.name.charAt(0).toUpperCase()}</div>
                  <div>
                    <div className="card-title" style={{ margin: 0 }}>{agent.name}</div>
                    <span className="badge" style={{ marginTop: 3, display: "inline-block" }}>archived</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {managers.length > 0 && (
            <div className="card mt-4">
              <div className="card-title">Org chart</div>
              <div className="col mt-2" style={{ gap: 12 }}>
                {managers.map(({ agent, reports }) => (
                  <div key={agent.id}>
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <div className="avatar" style={{ width: 26, height: 26, fontSize: 12 }}>
                        {agent.name.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{agent.name}</span>
                      <span className={roleBadgeClass(agent.role)}>{agent.role}</span>
                    </div>
                    {reports.map((r) => (
                      <div key={r.id} className="row" style={{ gap: 8, alignItems: "center", marginLeft: 32, marginTop: 6 }}>
                        <span className="faint" style={{ fontSize: 13 }}>↳</span>
                        <div className="avatar" style={{ width: 22, height: 22, fontSize: 11 }}>
                          {r.name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: 13 }}>{r.name}</span>
                        <span className={roleBadgeClass(r.role)}>{r.role}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {orgChart
                  .filter((n) => !n.agent.managerAgentId && n.reports.length === 0)
                  .map(({ agent }) => (
                    <div key={agent.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                      <div className="avatar" style={{ width: 26, height: 26, fontSize: 12 }}>
                        {agent.name.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: 14 }}>{agent.name}</span>
                      <span className={roleBadgeClass(agent.role)}>{agent.role}</span>
                      <span className="faint" style={{ fontSize: 12 }}>(no reports)</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {showCreate && (
        <Modal
          title="New agent"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn primary" onClick={handleCreate} disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create agent"}
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 16 }}>
            <Field label="Name">
              <input
                className="input"
                placeholder="e.g. Aria"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Role">
              <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
            <Field label="Goal">
              <textarea
                className="textarea"
                placeholder="What should this agent accomplish?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
              />
            </Field>
            <Field label="Monthly budget (USD)">
              <input
                className="input"
                type="number"
                placeholder="e.g. 100"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                min={0}
              />
            </Field>
          </div>
        </Modal>
      )}

      {runState && (
        <Modal
          title={`Run task — ${runState.agent.name}`}
          onClose={() => setRunState(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRunState(null)}>Cancel</button>
              <button
                className="btn primary"
                onClick={handleRunTask}
                disabled={submitting || !runState.task.trim()}
              >
                {submitting ? "Running…" : "Run"}
              </button>
            </>
          }
        >
          <Field label="Task">
            <textarea
              className="textarea"
              placeholder="Describe the task for this agent…"
              value={runState.task}
              onChange={(e) => setRunState({ ...runState, task: e.target.value })}
              rows={4}
              autoFocus
            />
          </Field>
        </Modal>
      )}
    </Shell>
  );
}
