import { Plug } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, Stat, timeAgo } from "../components/ui.js";
import { usePlatform, mutate, pushToast, markDone } from "../lib/store.js";

export function ConnectorsPage() {
  const p = usePlatform();
  const total = p.connectors.length;
  const connected = p.connectorHealthy();

  async function toggleConnector(name: string) {
    await mutate(() => {
      const c = p.connectors.find((x) => x.name === name)!;
      c.connected = !c.connected;
      c.lastSyncAt = c.connected ? new Date().toISOString() : undefined;
    });
    const c = p.connectors.find((x) => x.name === name)!;
    pushToast(c.connected ? `${c.label} connected` : `${c.label} disconnected`);
    markDone("connected_source");
  }

  return (
    <Shell title="Connectors" sub="Connect where work happens — ingested with original permissions preserved">
      <PageHeader
        title="Connectors"
        sub="Connect where work happens — ingested with original permissions preserved"
        actions={
          <Stat label="Status" value={`${connected} / ${total} connected`} />
        }
      />

      <p className="muted mb-4" style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 620 }}>
        Connected sources are continuously ingested into the Company Brain. Each document retains its
        original access-control list (ACL) from the source system, so agents and search results will
        never surface content a person couldn't already see.
      </p>

      <div className="grid cols-3" style={{ gap: 14 }}>
        {p.connectors.map((c) => (
          <div key={c.name} className="card hover col" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
              <div
                className="avatar"
                style={{ width: 36, height: 36, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <Plug size={17} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="card-title" style={{ fontWeight: 600 }}>{c.label}</div>
                <div className="faint" style={{ fontSize: 12 }}>{c.category}</div>
              </div>
            </div>

            <div className="row" style={{ gap: 6, alignItems: "center" }}>
              {c.connected ? (
                <>
                  <span className="badge-dot green" />
                  <span className="badge green">Connected</span>
                </>
              ) : (
                <>
                  <span className="badge-dot" />
                  <span className="badge">Not connected</span>
                </>
              )}
            </div>

            {c.connected && c.lastSyncAt && (
              <div className="faint" style={{ fontSize: 11 }}>
                Synced {timeAgo(c.lastSyncAt)}
              </div>
            )}

            <div className="mt-2">
              <button
                className={`btn sm ${c.connected ? "danger" : "primary"}`}
                style={{ width: "100%" }}
                onClick={() => toggleConnector(c.name)}
              >
                {c.connected ? "Disconnect" : "Connect"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Shell>
  );
}
