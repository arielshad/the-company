import { Sparkles } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, EmptyState } from "../components/ui.js";
import { api, type Skill } from "../lib/api.js";
import { useApi } from "../lib/hooks.js";

function statusBadge(status: Skill["status"]) {
  switch (status) {
    case "active": return <span className="badge green">active</span>;
    case "draft": return <span className="badge amber">draft</span>;
    case "deprecated": return <span className="badge">deprecated</span>;
  }
}

export function SkillsPage() {
  const { data: skills, loading, error } = useApi(() => api.skills(), []);

  return (
    <Shell title="Skills" sub="Reusable, versioned, eval-gated company skills">
      <PageHeader
        title="Skills"
        sub="Reusable, versioned, eval-gated company skills"
      />

      <p className="muted mb-4" style={{ fontSize: 13 }}>
        Skills are portable, versioned packages that agents can reuse across workflows. A skill cannot move from{" "}
        <strong>draft → active</strong> until its evaluation suite passes — the governance gate ensures quality before deployment.
      </p>

      {error && (
        <p className="badge red" style={{ marginBottom: 12 }}>{error}</p>
      )}

      {loading ? (
        <p className="faint" style={{ fontSize: 13 }}>Loading…</p>
      ) : !skills || skills.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={32} style={{ opacity: 0.35 }} />}
          title="No skills registered"
          sub="Skills are synced from Notion or GitHub. Connect a source to get started."
        />
      ) : (
        <div className="grid cols-2">
          {skills.map((skill) => {
            const changelog = skill.changelog ?? [];
            const latestLog = changelog[changelog.length - 1];
            return (
              <div key={skill.id} className="card hover col" style={{ gap: 12 }}>
                <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="card-title" style={{ margin: 0 }}>{skill.name}</span>
                      <span className="badge mono" style={{ fontSize: 11 }}>v{skill.version}</span>
                      {statusBadge(skill.status)}
                    </div>
                    <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
                      {skill.owner} · {skill.source}
                    </div>
                  </div>
                </div>

                {skill.description && (
                  <p style={{ fontSize: 13, margin: 0, lineHeight: 1.55 }}>{skill.description}</p>
                )}

                {skill.allowedRoles.length > 0 && (
                  <div className="row wrap" style={{ gap: 4 }}>
                    <span className="faint" style={{ fontSize: 12, marginRight: 2 }}>Roles:</span>
                    {skill.allowedRoles.map((r) => (
                      <span key={r} className="badge">{r}</span>
                    ))}
                  </div>
                )}

                {skill.requiredTools.length > 0 && (
                  <div className="row wrap" style={{ gap: 4 }}>
                    <span className="faint" style={{ fontSize: 12, marginRight: 2 }}>Tools:</span>
                    {skill.requiredTools.map((t) => (
                      <span key={t} className="mono" style={{ fontSize: 12, background: "var(--surface2, rgba(255,255,255,0.06))", padding: "2px 6px", borderRadius: 4 }}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                {latestLog && (
                  <div className="faint" style={{ fontSize: 12, borderTop: "1px solid var(--border, rgba(255,255,255,0.08))", paddingTop: 8 }}>
                    {latestLog}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
