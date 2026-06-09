import { KeyRound, Lock, Network, Database, RefreshCw, HelpCircle } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { startOnboarding, usePlatform, pushToast } from "../lib/store.js";

export function SettingsPage() {
  const p = usePlatform();
  const platformInfo = [
    { icon: KeyRound, title: "Single sign-on", value: "Keycloak (OIDC)", note: "Realm-as-code · roles → OpenFGA relations" },
    { icon: Lock, title: "Authorization", value: "OpenFGA (ReBAC)", note: "Checked on every tool call + retrieval" },
    { icon: Database, title: "Company brain", value: "pgvector + Graphiti", note: "Permission-aware, source-ACL filtered" },
    { icon: Network, title: "Deployment", value: "K8s · Argo CD app-of-apps", note: "Sealed Secrets · default-deny network policies" }
  ];

  return (
    <Shell title="Settings" sub="Organization, identity, and platform configuration">
      <div className="grid cols-2 mb-4">
        <div className="card">
          <div className="card-title mb-3">Organization</div>
          <div className="list">
            <div className="list-item"><span className="muted">Org</span><span className="spacer" /><span className="mono">{p.user.orgId}</span></div>
            <div className="list-item"><span className="muted">Signed in as</span><span className="spacer" /><span>Alice · <span className="badge blue">admin</span></span></div>
            <div className="list-item"><span className="muted">Groups</span><span className="spacer" /><span>{p.user.groups.join(", ") || "—"}</span></div>
            <div className="list-item"><span className="muted">Default model</span><span className="spacer" /><span className="mono">claude-sonnet-4-6</span></div>
          </div>
        </div>
        <div className="card">
          <div className="card-title mb-3">Workspace</div>
          <p className="faint" style={{ fontSize: 13 }}>This is a live in-browser demo org. Data is in-memory and resets on reload.</p>
          <div className="col mt-3" style={{ gap: 8 }}>
            <button className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => startOnboarding()}>
              <HelpCircle size={16} /> Replay the product tour
            </button>
            <button className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => { pushToast("Reloading demo…"); setTimeout(() => location.reload(), 400); }}>
              <RefreshCw size={16} /> Reset demo data
            </button>
          </div>
        </div>
      </div>

      <div className="card-title mb-3">Platform</div>
      <div className="grid cols-2">
        {platformInfo.map((i) => (
          <div className="card" key={i.title}>
            <div className="row">
              <div className="avatar"><i.icon size={16} /></div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{i.title}</div>
                <div className="faint" style={{ fontSize: 12 }}>{i.note}</div>
              </div>
              <div className="spacer" />
              <span className="badge green">{i.value}</span>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
