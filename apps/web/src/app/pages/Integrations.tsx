import { useState } from "react";
import { Plug, RefreshCw, Link2, Unplug, Send, KeyRound } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, Stat, Field, Modal, EmptyState, timeAgo } from "../components/ui.js";
import { useApi, useAction } from "../lib/hooks.js";
import { api, type Connector } from "../lib/api.js";
import { pushToast, markDone } from "../lib/store.js";

const SAMPLE_ZOOM = {
  meetingId: `zoom-${Math.floor(Date.parse("2026-06-12T00:00:00Z") / 1000)}`,
  topic: "Acme x Globex — Q3 renewal",
  transcript:
    "Alice: Decision: we will prioritize SSO for the August release.\nSam: Budget for expansion approved at 250 seats.\nAlice: Risk - SSO slipping past August may delay Globex expansion.\nAlice: Action item - Bob to scope SSO and open a Jira ticket."
};

function StatusBadge({ c }: { c: Connector }) {
  if (c.connected) return (<><span className="badge-dot green" /><span className="badge green">Connected</span></>);
  if (c.configured) return (<><span className="badge-dot amber" /><span className="badge amber">Configured</span></>);
  return (<><span className="badge-dot" /><span className="badge">Demo</span></>);
}

export function IntegrationsPage() {
  const { data: connectors, loading, error, refetch } = useApi(() => api.connectors(), []);
  const [connectName, setConnectName] = useState<string | null>(null);
  const [token, setToken] = useState("");

  const connect = useAction(api.connectToken);
  const backfill = useAction(api.backfill);
  const disconnect = useAction(api.disconnect);
  const webhook = useAction(api.webhook);

  const list = connectors ?? [];
  const connected = list.filter((c) => c.connected).length;
  const target = list.find((c) => c.name === connectName);

  async function doConnectToken() {
    if (!connectName || !token.trim()) return;
    if (await connect.run(connectName, token.trim())) {
      pushToast(`${target?.label} connected`);
      markDone("connected_source");
      setConnectName(null);
      setToken("");
      refetch();
    }
  }

  async function doOAuth(name: string) {
    try {
      const url = await api.authorizeUrl(name);
      window.open(url, "_blank", "noopener");
      pushToast("Opened the provider's consent screen in a new tab");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "OAuth not available", "error");
    }
  }

  async function doBackfill(name: string, label: string) {
    const ok = await backfill.run(name);
    if (ok) {
      pushToast(`${label}: backfill complete`);
      refetch();
    } else {
      pushToast(backfill.error ?? "Backfill failed", "error");
    }
  }

  async function doDisconnect(name: string, label: string) {
    if (await disconnect.run(name)) {
      pushToast(`${label} disconnected`);
      refetch();
    }
  }

  async function sendTestEvent(name: string) {
    const ok = await webhook.run(name, SAMPLE_ZOOM);
    if (ok) {
      pushToast("Test transcript ingested — see Brain / Governance");
      markDone("connected_source");
      refetch();
    } else {
      pushToast(webhook.error ?? "Webhook failed", "error");
    }
  }

  return (
    <Shell title="Integrations" sub="Connect where work happens — ingested with original permissions preserved">
      <PageHeader
        title="Integrations"
        sub="Connect where work happens — ingested with original permissions preserved"
        actions={<Stat label="Status" value={`${connected} / ${list.length} connected`} />}
      />

      <p className="muted mb-4" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 640 }}>
        Connected sources are ingested into the Company Brain. Each document keeps its original
        access-control list from the source, so agents and search never surface content a person
        couldn't already see. <strong>Configured</strong> means OAuth creds are present (connect via the
        provider); <strong>Demo</strong> means no live link yet — paste a token to connect now.
      </p>

      {error && <div className="card mb-3" style={{ borderColor: "var(--danger)" }}>Failed to load integrations: {error}</div>}
      {loading && <div className="faint">Loading integrations…</div>}

      {!loading && list.length === 0 ? (
        <EmptyState icon={<Plug size={32} style={{ opacity: 0.35 }} />} title="No integrations" sub="The connector catalog is empty." />
      ) : (
        <div className="grid cols-3" style={{ gap: 14 }}>
          {list.map((c) => (
            <div key={c.name} className="card hover col" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Plug size={17} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-title" style={{ fontWeight: 600 }}>{c.label}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{c.category} · {c.kind}</div>
                </div>
              </div>

              <div className="row" style={{ gap: 6, alignItems: "center" }}><StatusBadge c={c} /></div>
              {c.connected && c.lastSyncAt && (
                <div className="faint" style={{ fontSize: 11 }}>Synced {timeAgo(c.lastSyncAt)}</div>
              )}

              <div className="row mt-2" style={{ gap: 6, flexWrap: "wrap" }}>
                {c.kind === "source" && !c.connected && (
                  <button className="btn sm primary" style={{ flex: 1 }} onClick={() => { setConnectName(c.name); setToken(""); }}>
                    <Link2 size={13} /> Connect
                  </button>
                )}
                {c.kind === "source" && c.connected && (
                  <>
                    <button className="btn sm" style={{ flex: 1 }} disabled={backfill.pending} onClick={() => doBackfill(c.name, c.label)}>
                      <RefreshCw size={13} /> {backfill.pending ? "Syncing…" : "Backfill"}
                    </button>
                    <button className="btn ghost sm danger" disabled={disconnect.pending} onClick={() => doDisconnect(c.name, c.label)}>
                      <Unplug size={13} /> Disconnect
                    </button>
                  </>
                )}
                {c.kind === "webhook" && (
                  <button className="btn sm" style={{ flex: 1 }} disabled={webhook.pending} onClick={() => sendTestEvent(c.name)}>
                    <Send size={13} /> {webhook.pending ? "Sending…" : "Send test event"}
                  </button>
                )}
                {c.kind === "outbound" && (
                  <span className="faint" style={{ fontSize: 12 }}>{c.connected ? "Ready (token in config)" : "Set the bot token in config to enable"}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {connectName && target && (
        <Modal
          title={`Connect ${target.label}`}
          onClose={() => setConnectName(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConnectName(null)}>Cancel</button>
              <button className="btn primary" disabled={connect.pending || !token.trim()} onClick={doConnectToken}>
                {connect.pending ? "Connecting…" : "Connect"}
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 16 }}>
            {target.configured && (
              <>
                <button className="btn" style={{ justifyContent: "center" }} onClick={() => doOAuth(target.name)}>
                  <KeyRound size={15} /> Continue with {target.label} OAuth
                </button>
                <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>— or —</div>
              </>
            )}
            <Field label="Access token">
              <input
                className="input"
                placeholder="Paste an access token to connect now"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
            </Field>
            <p className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
              The token is stored server-side for this org and used to back-fill {target.label} into the brain.
              It is never sent back to the browser.
            </p>
            {connect.error && <div style={{ color: "var(--danger)", fontSize: 12 }}>{connect.error}</div>}
          </div>
        </Modal>
      )}
    </Shell>
  );
}
