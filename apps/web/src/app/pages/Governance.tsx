import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, EmptyState, timeAgo } from "../components/ui.js";
import { pushToast } from "../lib/store.js";
import { useApi, useAction } from "../lib/hooks.js";
import { api, type Approval } from "../lib/api.js";

type Tab = "approvals" | "audit" | "budgets";

export function GovernancePage() {
  const [tab, setTab] = useState<Tab>("approvals");

  const approvals = useApi(() => api.approvals(), []);
  const audit = useApi(() => api.audit(), []);
  const budgets = useApi(() => api.budgets(), []);

  const decideAction = useAction(api.decideApproval);

  const pending = (approvals.data ?? []).filter((a) => a.status === "pending");
  const auditRecords = (audit.data?.audit ?? []).slice(0, 50);
  const digest = audit.data?.digest;
  const budgetRows = budgets.data ?? [];

  async function decide(req: Approval, verdict: "approved" | "rejected") {
    const ok = await decideAction.run(req.id, verdict, "Reviewed in console");
    if (ok) {
      pushToast(verdict === "approved" ? "Approved" : "Rejected");
      approvals.refetch();
    } else if (decideAction.error) {
      pushToast(decideAction.error, "error");
    }
  }

  return (
    <Shell title="Governance" sub="Permissions, approvals, budgets and an immutable audit trail">
      <PageHeader
        title="Governance"
        sub="Permissions, approvals, budgets and an immutable audit trail"
      />

      <div className="tabs mb-4">
        <button
          className={`tab${tab === "approvals" ? " active" : ""}`}
          onClick={() => setTab("approvals")}
        >
          Approvals
          {pending.length > 0 && (
            <span className="badge amber" style={{ marginLeft: 6 }}>{pending.length}</span>
          )}
        </button>
        <button
          className={`tab${tab === "audit" ? " active" : ""}`}
          onClick={() => setTab("audit")}
        >
          Audit log
        </button>
        <button
          className={`tab${tab === "budgets" ? " active" : ""}`}
          onClick={() => setTab("budgets")}
        >
          Budgets
        </button>
      </div>

      {tab === "approvals" && (
        <>
          {approvals.loading && <div className="faint">Loading…</div>}
          {approvals.error && (
            <div className="faint" style={{ color: "var(--red, #e55)" }}>{approvals.error}</div>
          )}
          {!approvals.loading && !approvals.error && (
            pending.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck size={32} style={{ opacity: 0.35 }} />}
                title="No pending approvals"
                sub="All workflow approval gates are clear. Approvals appear here when a workflow node requires human sign-off."
              />
            ) : (
              <div className="col" style={{ gap: 10 }}>
                {pending.map((req) => (
                  <div key={req.id} className="card col" style={{ gap: 10 }}>
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <div>
                        <span className="mono faint" style={{ fontSize: 12 }}>node:</span>{" "}
                        <span className="mono" style={{ fontSize: 12 }}>{req.nodeId}</span>
                      </div>
                      <div>
                        <span className="mono faint" style={{ fontSize: 12 }}>run:</span>{" "}
                        <span className="mono" style={{ fontSize: 12 }}>{req.runId}</span>
                      </div>
                      <div className="spacer" />
                      <span className="badge amber">pending</span>
                    </div>
                    <pre style={{
                      margin: 0,
                      padding: "8px 10px",
                      background: "var(--surface2, rgba(255,255,255,0.05))",
                      borderRadius: 6,
                      fontSize: 12,
                      fontFamily: "var(--font-mono, monospace)",
                      overflow: "auto",
                      maxHeight: 120,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word"
                    }}>
                      {JSON.stringify(req.payload, null, 2)}
                    </pre>
                    <div className="row" style={{ gap: 8 }}>
                      <button
                        className="btn primary sm"
                        disabled={decideAction.pending}
                        onClick={() => decide(req, "approved")}
                      >
                        Approve
                      </button>
                      <button
                        className="btn danger sm"
                        disabled={decideAction.pending}
                        onClick={() => decide(req, "rejected")}
                      >
                        Reject
                      </button>
                      <span className="faint" style={{ fontSize: 12, marginLeft: 4 }}>
                        {timeAgo(new Date(req.createdAt).toISOString())}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {tab === "audit" && (
        <>
          {audit.loading && <div className="faint">Loading…</div>}
          {audit.error && (
            <div className="faint" style={{ color: "var(--red, #e55)" }}>{audit.error}</div>
          )}
          {!audit.loading && !audit.error && (
            auditRecords.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck size={32} style={{ opacity: 0.35 }} />}
                title="No audit records yet"
                sub="Actions performed by users, agents, and services are recorded here."
              />
            ) : (
              <div className="col" style={{ gap: 10 }}>
                {digest && (
                  <div className="row" style={{ gap: 6, alignItems: "center" }}>
                    <span className="faint" style={{ fontSize: 12 }}>integrity digest:</span>
                    <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{digest}</span>
                  </div>
                )}
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Decision</th>
                        <th>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditRecords.map((rec) => (
                        <tr key={rec.id}>
                          <td className="mono faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                            {timeAgo(rec.ts)}
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>{rec.actor.id}</td>
                          <td style={{ fontSize: 13 }}>{rec.action}</td>
                          <td>
                            {rec.decision === "allow" && <span className="badge green">allow</span>}
                            {rec.decision === "deny" && <span className="badge red">deny</span>}
                          </td>
                          <td className="mono faint" style={{ fontSize: 12 }}>
                            {rec.costUsd != null ? `$${rec.costUsd.toFixed(4)}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
        </>
      )}

      {tab === "budgets" && (
        <>
          {budgets.loading && <div className="faint">Loading…</div>}
          {budgets.error && (
            <div className="faint" style={{ color: "var(--red, #e55)" }}>{budgets.error}</div>
          )}
          {!budgets.loading && !budgets.error && (
            <div className="col" style={{ gap: 10 }}>
              {budgetRows.length === 0 ? (
                <EmptyState
                  icon={<ShieldCheck size={32} style={{ opacity: 0.35 }} />}
                  title="No agents"
                  sub="Create agents to track their budget usage here."
                />
              ) : (
                budgetRows.map((b) => {
                  const spent = b.spentUsd;
                  const cap = b.cap ?? 0;
                  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
                  const overBudget = spent >= cap && cap > 0;
                  const nearBudget = !overBudget && pct >= 80;
                  return (
                    <div key={b.agentId} className="card row" style={{ gap: 14, alignItems: "center" }}>
                      <div className="avatar" style={{ width: 30, height: 30, flexShrink: 0 }}>
                        {b.name.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{b.name}</span>
                          {overBudget && <span className="badge red">over budget</span>}
                          {nearBudget && <span className="badge amber">near limit</span>}
                        </div>
                        <div className="progress">
                          <div style={{
                            width: `${pct}%`,
                            background: overBudget
                              ? "var(--red, #e55)"
                              : nearBudget
                              ? "var(--amber, #f90)"
                              : "var(--accent, #4a9eff)"
                          }} />
                        </div>
                        <div className="row mt-2" style={{ fontSize: 12, gap: 4 }}>
                          <span className="faint mono">${spent.toFixed(2)}</span>
                          <span className="faint">/</span>
                          <span className="faint mono">${cap.toFixed(2)}</span>
                          {cap > 0 && <span className="muted" style={{ marginLeft: 4 }}>({pct.toFixed(0)}%)</span>}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}