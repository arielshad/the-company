import { useState } from "react";
import { KeyRound, Lock, Network, Database, HelpCircle, Building2, Plus } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { Field } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useApi, useAction } from "../lib/hooks.js";
import { startOnboarding, pushToast } from "../lib/store.js";

const ORG_ID_RE = /^[a-z0-9-]+$/;

export function SettingsPage() {
  const me = useApi(() => api.me(), []);
  const create = useAction(api.createOrg);
  const [orgId, setOrgId] = useState("");

  const platformInfo = [
    { icon: KeyRound, title: "Single sign-on", value: "Keycloak (OIDC)", note: "Realm-as-code · roles → OpenFGA relations" },
    { icon: Lock, title: "Authorization", value: "OpenFGA (ReBAC)", note: "Checked on every tool call + retrieval" },
    { icon: Database, title: "Company brain", value: "pgvector + Graphiti", note: "Permission-aware, source-ACL filtered" },
    { icon: Network, title: "Deployment", value: "K8s · Argo CD app-of-apps", note: "Sealed Secrets · default-deny network policies" }
  ];

  async function onCreateOrg() {
    const id = orgId.trim();
    if (!ORG_ID_RE.test(id)) {
      pushToast("Org id must match a-z, 0-9 and hyphens", "error");
      return;
    }
    const ok = await create.run(id);
    if (ok) {
      pushToast(`Organization “${id}” created`);
      setOrgId("");
      me.refetch();
    } else {
      pushToast(create.error ?? "Could not create organization", "error");
    }
  }

  return (
    <Shell title="Settings" sub="Organization, identity, and platform configuration">
      <div className="grid cols-2 mb-4">
        <div className="card">
          <div className="card-title mb-3">Organization</div>
          {me.loading && <p className="faint" style={{ fontSize: 13 }}>Loading…</p>}
          {me.error && <p className="faint" style={{ fontSize: 13, color: "var(--red, #e5484d)" }}>{me.error}</p>}
          {me.data && (
            <div className="list">
              <div className="list-item"><span className="muted">Org</span><span className="spacer" /><span className="mono">{me.data.orgId}</span></div>
              <div className="list-item">
                <span className="muted">Signed in as</span>
                <span className="spacer" />
                <span>
                  <span className="mono">{me.data.id}</span>
                  {me.data.roles.length > 0 && <> · {me.data.roles.map((r) => <span key={r} className="badge blue" style={{ marginLeft: 4 }}>{r}</span>)}</>}
                </span>
              </div>
              <div className="list-item"><span className="muted">Groups</span><span className="spacer" /><span>{me.data.groups.join(", ") || "—"}</span></div>
              <div className="list-item"><span className="muted">Default model</span><span className="spacer" /><span className="mono">claude-sonnet-4-6</span></div>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title mb-3">Create organization</div>
          <p className="faint" style={{ fontSize: 13 }}>Self-serve tenancy — spin up a fresh org on the core API and switch into it.</p>
          <div className="col mt-3" style={{ gap: 10 }}>
            <Field label="Organization id">
              <input
                className="input"
                placeholder="acme-labs"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void onCreateOrg()}
              />
            </Field>
            <p className="faint mono" style={{ fontSize: 12 }}>Lowercase letters, numbers, and hyphens only.</p>
            <button
              className="btn primary"
              style={{ justifyContent: "center" }}
              disabled={create.pending || !ORG_ID_RE.test(orgId.trim())}
              onClick={() => void onCreateOrg()}
            >
              <Plus size={16} /> {create.pending ? "Creating…" : "Create organization"}
            </button>
          </div>
        </div>
      </div>

      <div className="card mb-4">
        <div className="row">
          <div className="avatar"><Building2 size={16} /></div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>Workspace</div>
            <div className="faint" style={{ fontSize: 12 }}>
              This UI is a live client of the core API server at <span className="mono">{api.base}</span>. Data is persisted by the server of record — the browser holds no platform state.
            </div>
          </div>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => startOnboarding()}>
            <HelpCircle size={16} /> Replay tour
          </button>
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