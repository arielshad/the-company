/**
 * PostgresMemoryStore — MemoryStore backed by `memory_items` (T3.3).
 *
 * The MemoryStore interface (getBySource/get/insert/update/allByOrg) is
 * synchronous because its reference impls are, and BrainService calls them
 * inline (ingest, search). Postgres is async, so — like PostgresAudit — this
 * adapter keeps a write-through in-memory mirror: construct via
 * `PostgresMemoryStore.create(pool)` (which hydrates from `memory_items` so
 * items survive a restart), serve reads from the mirror synchronously, and
 * enqueue ordered async upserts on insert/update.
 *
 * Vector seam (T3.3): the schema has a nullable `embedding vector(1536)`. The
 * BrainItem type does not (yet) carry an embedding, so we store NULL on
 * insert/update and expose:
 *   - `setEmbedding(orgId, id, vector)` to backfill an embedding, and
 *   - `searchByVector(orgId, queryVec, topK)` for ANN retrieval the brain's
 *     hybrid search can adopt later (it does NOT change the MemoryStore
 *     interface; `allByOrg` keeps working unchanged for today's JS scoring).
 */
import type { BrainItem, MemoryStore } from "@companyos/brain";
import type { Pool } from "pg";
import { withOrg } from "./pool.js";

interface MemoryRow {
  id: string;
  org_id: string;
  kind: string;
  type: string;
  title: string;
  content: string;
  source: BrainItem["source"];
  source_acl: BrainItem["sourceAcl"] | null;
  confidence: number;
  timestamp: string;
  visibility: string[];
  related_people: string[] | null;
  superseded_by: string | null;
  expires_at: string | null;
}

function rowToItem(r: MemoryRow): BrainItem {
  const item: BrainItem = {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind as BrainItem["kind"],
    type: r.type as BrainItem["type"],
    title: r.title,
    content: r.content,
    source: r.source,
    confidence: r.confidence,
    timestamp: r.timestamp,
    visibility: r.visibility ?? []
  };
  if (r.source_acl != null) item.sourceAcl = r.source_acl;
  if (r.related_people != null) item.relatedPeople = r.related_people;
  if (r.superseded_by != null) item.supersededBy = r.superseded_by;
  if (r.expires_at != null) item.expiresAt = r.expires_at;
  return item;
}

/** Serialize a JS number[] into the pgvector text literal `[a,b,c]`. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

export interface VectorHit {
  id: string;
  distance: number;
}

export class PostgresMemoryStore implements MemoryStore {
  private items = new Map<string, BrainItem>(); // id -> item
  private bySource = new Map<string, string>(); // orgId|connector|externalId -> id
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(
    private pool: Pool,
    private onError: (err: unknown) => void = (e) => console.error("[PostgresMemoryStore] write failed:", e)
  ) {}

  static async create(pool: Pool, onError?: (err: unknown) => void): Promise<PostgresMemoryStore> {
    const store = new PostgresMemoryStore(pool, onError);
    await store.hydrate();
    return store;
  }

  private sourceKey(orgId: string, connector: string, externalId: string): string {
    return `${orgId}|${connector}|${externalId}`;
  }

  private remember(item: BrainItem): void {
    this.items.set(item.id, item);
    this.bySource.set(this.sourceKey(item.orgId, item.source.connector, item.source.externalId), item.id);
  }

  private async hydrate(): Promise<void> {
    for (const orgId of await this.allOrgIds()) {
      const items = await withOrg(this.pool, orgId, async (client) => {
        const { rows } = await client.query<MemoryRow>(
          `SELECT id, org_id, kind, type, title, content, source, source_acl, confidence,
                  timestamp, visibility, related_people, superseded_by, expires_at
           FROM memory_items`
        );
        return rows.map(rowToItem);
      });
      for (const item of items) this.remember(item);
    }
  }

  /** See PostgresAudit.allOrgIds — same FORCE-RLS hydration contract. */
  private async allOrgIds(): Promise<string[]> {
    const explicit = process.env.MEMORY_HYDRATE_ORG ?? process.env.AUDIT_HYDRATE_ORG;
    if (explicit) return explicit.split(",").map((s) => s.trim()).filter(Boolean);
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ org_id: string }>("SELECT DISTINCT org_id FROM memory_items");
      return rows.map((r) => r.org_id);
    } catch {
      return [];
    } finally {
      client.release();
    }
  }

  // ---- MemoryStore interface (synchronous, served from the mirror) ----------

  getBySource(orgId: string, connector: string, externalId: string): BrainItem | undefined {
    const id = this.bySource.get(this.sourceKey(orgId, connector, externalId));
    return id ? this.items.get(id) : undefined;
  }

  get(id: string): BrainItem | undefined {
    return this.items.get(id);
  }

  insert(item: BrainItem): void {
    this.remember(item);
    this.enqueueUpsert(item);
  }

  update(item: BrainItem): void {
    this.remember(item);
    this.enqueueUpsert(item);
  }

  allByOrg(orgId: string): BrainItem[] {
    const out: BrainItem[] = [];
    for (const item of this.items.values()) if (item.orgId === orgId) out.push(item);
    return out;
  }

  // ---- Durable write (ordered, fire-and-forget) -----------------------------

  private enqueueUpsert(item: BrainItem): void {
    // embedding is left NULL here — T3.3 backfills via setEmbedding(). The seam
    // is intentional: BrainItem has no embedding field today.
    this.writeTail = this.writeTail.then(() =>
      withOrg(this.pool, item.orgId, async (client) => {
        await client.query(
          `INSERT INTO memory_items
             (id, org_id, kind, type, title, content, source, source_acl, confidence,
              timestamp, visibility, related_people, superseded_by, expires_at,
              connector, external_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (org_id, id) DO UPDATE SET
             kind = EXCLUDED.kind,
             type = EXCLUDED.type,
             title = EXCLUDED.title,
             content = EXCLUDED.content,
             source = EXCLUDED.source,
             source_acl = EXCLUDED.source_acl,
             confidence = EXCLUDED.confidence,
             timestamp = EXCLUDED.timestamp,
             visibility = EXCLUDED.visibility,
             related_people = EXCLUDED.related_people,
             superseded_by = EXCLUDED.superseded_by,
             expires_at = EXCLUDED.expires_at,
             connector = EXCLUDED.connector,
             external_id = EXCLUDED.external_id`,
          [
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
            JSON.stringify(item.visibility ?? []),
            item.relatedPeople != null ? JSON.stringify(item.relatedPeople) : null,
            item.supersededBy ?? null,
            item.expiresAt ?? null,
            item.source.connector,
            item.source.externalId
          ]
        );
      }).catch(this.onError)
    );
  }

  /** Await all queued durable writes (tests/shutdown). */
  async flush(): Promise<void> {
    await this.writeTail;
  }

  // ---- Vector seam (T3.3) ---------------------------------------------------

  /** Backfill/set an item's embedding (1536-dim). Updates the durable row. */
  async setEmbedding(orgId: string, id: string, vector: number[]): Promise<void> {
    await this.flush();
    await withOrg(this.pool, orgId, async (client) => {
      await client.query("UPDATE memory_items SET embedding = $1::vector WHERE id = $2", [
        toVectorLiteral(vector),
        id
      ]);
    });
  }

  /**
   * Approximate-nearest-neighbour over embeddings (cosine distance). Returns the
   * topK closest item ids for the org. The brain's hybrid scorer can blend these
   * with its existing keyword/recency signals later; today's `allByOrg`-based
   * path is unchanged.
   */
  async searchByVector(orgId: string, queryVec: number[], topK = 5): Promise<VectorHit[]> {
    return withOrg(this.pool, orgId, async (client) => {
      const { rows } = await client.query<{ id: string; distance: number }>(
        `SELECT id, embedding <=> $1::vector AS distance
         FROM memory_items
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [toVectorLiteral(queryVec), topK]
      );
      return rows.map((r) => ({ id: r.id, distance: Number(r.distance) }));
    });
  }
}
