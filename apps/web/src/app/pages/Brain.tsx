import { useState } from "react";
import { Search, ExternalLink, Network, Clock } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, Stat, Field, EmptyState } from "../components/ui.js";
import { useApi } from "../lib/hooks.js";
import { api, type SearchHit, type GraphEntity, type GraphEdge } from "../lib/api.js";
import { pushToast, markDone } from "../lib/store.js";

const EXAMPLES = ["Globex SSO renewal", "ideal customer profile", "Q3 board update"];

export function BrainPage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Sources connected — count of healthy/connected connectors (FR replaces brain.count).
  const connectors = useApi(() => api.connectors(), []);
  const sourceCount = connectors.data ? connectors.data.filter((c) => c.connected).length : 0;

  // Knowledge graph (FR-3.3): entity picker + time-travel neighbors.
  const entities = useApi(() => api.graphEntities(), []);
  const [selected, setSelected] = useState<string>("");
  const [asOf, setAsOf] = useState<string>("");
  const neighbors = useApi<GraphEdge[]>(
    () => (selected ? api.graphNeighbors(selected, asOf || undefined) : Promise.resolve([])),
    [selected, asOf]
  );

  async function runSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSearching(true);
    try {
      const res = await api.search(trimmed);
      setHits(res);
      markDone("searched_brain");
    } catch (e) {
      setHits([]);
      pushToast(e instanceof Error ? e.message : "Search failed", "error");
    } finally {
      setSearching(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") runSearch(query);
  }

  function pickExample(ex: string) {
    setQuery(ex);
    runSearch(ex);
  }

  return (
    <Shell title="Company Brain" sub="Permission-aware search across your connected knowledge">
      <PageHeader title="Company Brain" sub="Permission-aware search across your connected knowledge" />

      {/* Stats */}
      <div className="row mb-4" style={{ gap: 12 }}>
        <Stat
          label="Sources connected"
          value={connectors.loading ? <span className="faint">Loading…</span> : sourceCount}
          hint="Healthy connectors feeding the brain"
        />
        <Stat
          label="Entities tracked"
          value={entities.loading ? <span className="faint">Loading…</span> : entities.data?.length ?? 0}
          hint="Across the knowledge graph"
        />
      </div>

      {/* Search box */}
      <div className="card mb-3">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="e.g. Globex SSO renewal"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={searching}
          />
          <button
            className="btn primary"
            onClick={() => runSearch(query)}
            disabled={searching || !query.trim()}
          >
            <Search size={15} />
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        {/* Example chips */}
        <div className="row wrap mt-2" style={{ gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="badge blue"
              style={{ cursor: "pointer", border: "none", background: "none" }}
              onClick={() => pickExample(ex)}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      {hits === null ? (
        <EmptyState
          icon={<Search size={32} style={{ opacity: 0.35 }} />}
          title="Search company knowledge"
          sub="Ask anything across Notion, Google Drive, GitHub, Zoom, and more. Results are filtered by your permissions."
        />
      ) : hits.length === 0 ? (
        <EmptyState
          icon={<Search size={32} style={{ opacity: 0.35 }} />}
          title="No results found"
          sub="No documents matched your query — or they exist but your account doesn't have access. The Brain only surfaces content you're permitted to see based on the original source permissions."
        />
      ) : (
        <div className="col" style={{ gap: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>{hits.length} result{hits.length !== 1 ? "s" : ""}</div>
          {hits.map((hit) => (
            <div key={hit.id} className="card hover hit">
              <div className="hit-title">{hit.title}</div>
              <p style={{ margin: "6px 0 8px", fontSize: 13, lineHeight: 1.55 }}>{hit.snippet}</p>
              <div className="row wrap hit-meta" style={{ gap: 6, alignItems: "center" }}>
                <span className="badge blue">{hit.source.connector}</span>
                <span className="badge">{hit.type}</span>
                <span className="faint mono" style={{ fontSize: 11 }}>score {hit.score.toFixed(2)}</span>
                <div className="spacer" />
                {hit.source.url && (
                  <a
                    href={hit.source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn ghost sm"
                    style={{ fontSize: 12 }}
                  >
                    <ExternalLink size={12} /> Open
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Knowledge graph (FR-3.3) — entity picker + time-travel facts */}
      <div className="card mt-4">
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <Network size={16} />
          <h3 style={{ fontSize: 15 }}>Knowledge graph</h3>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 12 }}>Time-travel over what the brain knew</span>
        </div>

        <div className="row wrap mt-3" style={{ gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Field label="Entity">
              {entities.loading ? (
                <div className="faint" style={{ fontSize: 13 }}>Loading…</div>
              ) : entities.error ? (
                <div className="badge red">{entities.error}</div>
              ) : (
                <select
                  className="select"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">Select an entity…</option>
                  {(entities.data ?? []).map((ent: GraphEntity) => (
                    <option key={ent.id} value={ent.name}>
                      {ent.name} ({ent.type})
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <div style={{ width: 200 }}>
            <Field label="As of (optional)">
              <input
                className="input"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="mt-3">
          {!selected ? (
            <EmptyState
              icon={<Network size={32} style={{ opacity: 0.35 }} />}
              title="Pick an entity"
              sub="Select an entity to inspect its facts. Add an “as of” date to see what the graph knew at that point in time."
            />
          ) : neighbors.loading ? (
            <div className="faint" style={{ fontSize: 13 }}>Loading…</div>
          ) : neighbors.error ? (
            <div className="badge red">{neighbors.error}</div>
          ) : (neighbors.data ?? []).length === 0 ? (
            <EmptyState
              icon={<Network size={32} style={{ opacity: 0.35 }} />}
              title="No facts known"
              sub={asOf ? `No facts about ${selected} were valid as of ${asOf}.` : `No facts recorded about ${selected} yet.`}
            />
          ) : (
            <div className="list">
              {(neighbors.data ?? []).map((edge: GraphEdge) => (
                <div key={edge.id} className="list-item">
                  <div className="row" style={{ gap: 6, alignItems: "center" }}>
                    <span className="badge blue">{edge.predicate}</span>
                    <span className="faint">→</span>
                    <span style={{ fontWeight: 600 }}>{edge.object}</span>
                    <div className="spacer" />
                    <span className="faint mono" style={{ fontSize: 11 }}>{(edge.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <div className="row mt-1" style={{ gap: 6, alignItems: "center" }}>
                    <Clock size={11} style={{ opacity: 0.5 }} />
                    <span className="faint mono" style={{ fontSize: 11 }}>
                      valid from {edge.validFrom}
                      {edge.validTo ? ` — to ${edge.validTo}` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
