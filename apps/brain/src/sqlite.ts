import { createRequire } from "node:module";
import type { BrainItem, MemoryStore } from "./index.js";

// Loaded via createRequire so the bundler never tries to resolve node:sqlite
// (it is newer than some bundlers' builtin lists). Types are preserved.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DB = InstanceType<typeof DatabaseSync>;

interface Row {
  id: string;
  orgId: string;
  kind: string;
  type: string;
  title: string;
  content: string;
  source: string;
  sourceAcl: string | null;
  confidence: number;
  timestamp: string;
  visibility: string;
  relatedPeople: string | null;
  supersededBy: string | null;
  expiresAt: string | null;
  connector: string;
  externalId: string;
}

function rowToItem(r: Row): BrainItem {
  const item: BrainItem = {
    id: r.id,
    orgId: r.orgId,
    kind: r.kind as BrainItem["kind"],
    type: r.type as BrainItem["type"],
    title: r.title,
    content: r.content,
    source: JSON.parse(r.source) as BrainItem["source"],
    confidence: r.confidence,
    timestamp: r.timestamp,
    visibility: JSON.parse(r.visibility) as string[]
  };
  if (r.sourceAcl != null) item.sourceAcl = JSON.parse(r.sourceAcl) as BrainItem["sourceAcl"];
  if (r.relatedPeople != null) item.relatedPeople = JSON.parse(r.relatedPeople) as string[];
  if (r.supersededBy != null) item.supersededBy = r.supersededBy;
  if (r.expiresAt != null) item.expiresAt = r.expiresAt;
  return item;
}

/**
 * Durable SQLite-backed memory store (node-only — uses node:sqlite).
 * Implements the same MemoryStore interface as InMemoryMemoryStore, so it drops
 * into BrainService unchanged. Items survive process restarts (proven in sqlite.test.ts).
 */
export class SqliteMemoryStore implements MemoryStore {
  private db: DB;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        kind TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        sourceAcl TEXT,
        confidence REAL NOT NULL,
        timestamp TEXT NOT NULL,
        visibility TEXT NOT NULL,
        relatedPeople TEXT,
        supersededBy TEXT,
        expiresAt TEXT,
        connector TEXT NOT NULL,
        externalId TEXT NOT NULL
      )`
    );
  }

  insert(item: BrainItem): void {
    this.db
      .prepare(
        `INSERT INTO memory (id, orgId, kind, type, title, content, source, sourceAcl, confidence, timestamp, visibility, relatedPeople, supersededBy, expiresAt, connector, externalId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.orgId,
        item.kind,
        item.type,
        item.title,
        item.content,
        JSON.stringify(item.source),
        item.sourceAcl != null ? JSON.stringify(item.sourceAcl) : null,
        item.confidence,
        item.timestamp,
        JSON.stringify(item.visibility),
        item.relatedPeople != null ? JSON.stringify(item.relatedPeople) : null,
        item.supersededBy ?? null,
        item.expiresAt ?? null,
        item.source.connector,
        item.source.externalId
      );
  }

  update(item: BrainItem): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory (id, orgId, kind, type, title, content, source, sourceAcl, confidence, timestamp, visibility, relatedPeople, supersededBy, expiresAt, connector, externalId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.orgId,
        item.kind,
        item.type,
        item.title,
        item.content,
        JSON.stringify(item.source),
        item.sourceAcl != null ? JSON.stringify(item.sourceAcl) : null,
        item.confidence,
        item.timestamp,
        JSON.stringify(item.visibility),
        item.relatedPeople != null ? JSON.stringify(item.relatedPeople) : null,
        item.supersededBy ?? null,
        item.expiresAt ?? null,
        item.source.connector,
        item.source.externalId
      );
  }

  getBySource(orgId: string, connector: string, externalId: string): BrainItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory WHERE orgId = ? AND connector = ? AND externalId = ?")
      .get(orgId, connector, externalId) as unknown as Row | undefined;
    return row ? rowToItem(row) : undefined;
  }

  get(id: string): BrainItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory WHERE id = ?")
      .get(id) as unknown as Row | undefined;
    return row ? rowToItem(row) : undefined;
  }

  allByOrg(orgId: string): BrainItem[] {
    const rows = this.db
      .prepare("SELECT * FROM memory WHERE orgId = ?")
      .all(orgId) as unknown as Row[];
    return rows.map(rowToItem);
  }

  close(): void {
    this.db.close();
  }
}
