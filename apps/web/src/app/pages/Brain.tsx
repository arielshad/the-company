import { useState } from "react";
import { Search, ExternalLink } from "lucide-react";
import { Shell } from "../components/Shell.js";
import { PageHeader, Stat, EmptyState } from "../components/ui.js";
import { usePlatform, mutate, pushToast, markDone } from "../lib/store.js";

interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  type: string;
  source: { connector: string; url?: string };
}

const EXAMPLES = ["Globex SSO renewal", "ideal customer profile", "Q3 board update"];

export function BrainPage() {
  const p = usePlatform();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  async function runSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSearching(true);
    try {
      const res = await mutate(() => p.search(trimmed));
      if (res.ok && Array.isArray(res.result)) {
        setHits(res.result as SearchHit[]);
      } else {
        setHits([]);
        if (!res.ok) pushToast(res.error ?? "Search failed", "error");
      }
      markDone("searched_brain");
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

  const memoryCount = p.brain.count(p.user.orgId);
  const sourceCount = p.connectorHealthy();

  return (
    <Shell title="Company Brain" sub="Permission-aware search across your connected knowledge">
      <PageHeader title="Company Brain" sub="Permission-aware search across your connected knowledge" />

      {/* Stats */}
      <div className="row mb-4" style={{ gap: 12 }}>
        <Stat label="Total memories" value={memoryCount} hint="Across all connected sources" />
        <Stat label="Connected sources" value={sourceCount} hint="Healthy connectors" />
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
    </Shell>
  );
}
