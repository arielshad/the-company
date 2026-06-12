import { useState } from "react";
import { Network, Clock } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, EmptyState, timeAgo } from "../components/ui.js";
import { useApi } from "../lib/hooks.js";
import { api } from "../lib/api.js";

export function GraphPage() {
  const entities = useApi(() => api.graphEntities(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string>("");

  const neighbors = useApi(
    () => (selected ? api.graphNeighbors(selected, asOf || undefined) : Promise.resolve([])),
    [selected, asOf]
  );

  const list = entities.data ?? [];

  return (
    <Shell title="Memory Graph" sub="Temporal knowledge graph — entities, facts, and how they changed over time">
      <PageHeader title="Memory Graph" sub="Bitemporal entity/edge graph (FR-3.3). Pick an entity to see its facts, and travel back in time." />

      {entities.loading && <div className="faint">Loading graph…</div>}
      {entities.error && <div className="card" style={{ borderColor: "var(--danger)" }}>Failed to load graph: {entities.error}</div>}

      {!entities.loading && list.length === 0 ? (
        <EmptyState
          icon={<Network size={32} style={{ opacity: 0.35 }} />}
          title="The graph is empty"
          sub="Connect a source and run a backfill (or send a test transcript) — episodes are indexed into the temporal graph as they ingest."
        />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 16 }}>
          <div className="card col" style={{ gap: 4, maxHeight: 520, overflow: "auto" }}>
            <div className="stat-label mb-2">Entities ({list.length})</div>
            {list.map((e) => (
              <button
                key={e.id}
                className={`list-item ${selected === e.name ? "active" : ""}`}
                style={{ border: "none", background: selected === e.name ? "var(--surface2, rgba(255,255,255,0.06))" : "none", textAlign: "left", cursor: "pointer", borderRadius: 6 }}
                onClick={() => setSelected(e.name)}
              >
                <span className="badge-dot" />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</div>
                  <div className="faint" style={{ fontSize: 11 }}>{e.type} · seen {timeAgo(e.lastSeen)}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="card col" style={{ gap: 12 }}>
            {!selected ? (
              <EmptyState icon={<Network size={26} />} title="Select an entity" sub="Its facts (edges) appear here." />
            ) : (
              <>
                <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div className="card-title" style={{ margin: 0 }}>{selected}</div>
                  <div className="spacer" />
                  <Clock size={14} className="faint" />
                  <label className="faint" style={{ fontSize: 12 }}>as of</label>
                  <input
                    className="input"
                    style={{ width: 200 }}
                    type="datetime-local"
                    value={asOf}
                    onChange={(e) => setAsOf(e.target.value ? new Date(e.target.value).toISOString() : "")}
                  />
                  {asOf && <button className="btn ghost sm" onClick={() => setAsOf("")}>Now</button>}
                </div>

                {neighbors.loading && <div className="faint">Loading facts…</div>}
                {!neighbors.loading && (neighbors.data?.length ?? 0) === 0 ? (
                  <div className="faint" style={{ fontSize: 13 }}>No facts {asOf ? "valid at that time" : "for this entity"}.</div>
                ) : (
                  <div className="list">
                    {(neighbors.data ?? []).map((edge) => (
                      <div className="list-item" key={edge.id}>
                        <span className="badge blue">{edge.predicate}</span>
                        <span style={{ fontSize: 13 }}>{edge.object}</span>
                        <div className="spacer" />
                        <span className="faint mono" style={{ fontSize: 11 }}>
                          {timeAgo(edge.validFrom)}
                          {edge.validTo ? ` → ${timeAgo(edge.validTo)}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="faint" style={{ fontSize: 12 }}>
                  Facts supersede over time: a new value for the same (subject, predicate) closes the old one.
                  Set an "as of" time to see what the graph believed then.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
