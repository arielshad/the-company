import { Sparkles } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, EmptyState } from "../components/ui.js";
import { usePlatform, mutate, pushToast } from "../lib/store.js";
import type { Skill } from "@companyos/schemas";

const PASSING_CANDIDATE = {
  claims: ["prioritize SSO for the August release"],
  citations: [
    {
      sourceRef: "zoom",
      quote: "Decision: we will prioritize SSO for the August release."
    }
  ],
  toolsUsed: [] as string[],
  allowedTools: [] as string[]
};

function statusBadge(status: Skill["status"]) {
  switch (status) {
    case "active": return <span className="badge green">active</span>;
    case "draft": return <span className="badge amber">draft</span>;
    case "deprecated": return <span className="badge">deprecated</span>;
  }
}

export function SkillsPage() {
  const p = usePlatform();
  const orgId = p.user.orgId;
  const skills = p.skills.list(orgId);

  async function handlePromote(skill: Skill & { changelog: string[] }) {
    try {
      await mutate(() => p.skills.promote(skill.id, PASSING_CANDIDATE));
      const result = p.skills.list(orgId).find((s) => s.id === skill.id);
      if (result?.status === "active") {
        pushToast("Promoted to active (evals passed)", "ok");
      } else {
        pushToast("Promotion blocked: evals failed", "error");
      }
    } catch (err) {
      pushToast(`Promotion failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

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

      {skills.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={32} style={{ opacity: 0.35 }} />}
          title="No skills registered"
          sub="Skills are synced from Notion or GitHub. Connect a source to get started."
        />
      ) : (
        <div className="grid cols-2">
          {skills.map((skill) => {
            const changelog = (skill as Skill & { changelog: string[] }).changelog ?? [];
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
                  {skill.status === "draft" && (
                    <button
                      className="btn sm primary"
                      onClick={() => handlePromote(skill as Skill & { changelog: string[] })}
                    >
                      Promote
                    </button>
                  )}
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
