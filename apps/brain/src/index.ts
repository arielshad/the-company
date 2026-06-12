import {
  MemoryObject,
  MemoryType,
  newId,
  type MemoryWritePolicy,
  type SourceRef
} from "@companyos/schemas";
import {
  type AuthzEngine,
  type Principal,
  type SourceAcl,
  sourceAclAdmits
} from "@companyos/auth";
import { type AuditSink, makeAuditRecord } from "@companyos/telemetry";
import { type Embedder, cosineVec } from "./embeddings.js";
import {
  type MemoryGraph,
  type EntityExtractor,
  type GraphEdge,
  type GraphEntity,
  type NeighborQuery,
  DeterministicExtractor
} from "./graph.js";

export type { Embedder } from "./embeddings.js";
export { OpenAiCompatibleEmbedder, HashingEmbedder, cosineVec } from "./embeddings.js";
export type {
  MemoryGraph,
  EntityExtractor,
  GraphEdge,
  GraphEntity,
  NeighborQuery,
  Extraction,
  AddEpisodeInput
} from "./graph.js";
export { InMemoryMemoryGraph, DeterministicExtractor } from "./graph.js";

/**
 * Company Brain (docs/02 §6, docs/04 §2; PHASE-02).
 * Ingestion + hybrid permission-aware retrieval + typed memory write/lifecycle.
 *
 * Vector search uses a bag-of-words embedding so it runs offline & deterministic;
 * the retrieval interface is backend-agnostic (pgvector/Qdrant in prod, ADR-0004).
 */

export interface BrainItem {
  id: string;
  orgId: string;
  kind: "doc" | "memory";
  type: MemoryType;
  title: string;
  content: string;
  source: SourceRef;
  sourceAcl?: SourceAcl;
  confidence: number;
  timestamp: string;
  visibility: string[];
  relatedPeople?: string[];
  supersededBy?: string;
  expiresAt?: string;
  /** Cached dense embedding (populated lazily on first search when an Embedder is wired). */
  embedding?: number[];
}

export interface MemoryStore {
  getBySource(orgId: string, connector: string, externalId: string): BrainItem | undefined;
  get(id: string): BrainItem | undefined;
  insert(item: BrainItem): void;
  update(item: BrainItem): void;
  allByOrg(orgId: string): BrainItem[];
}

export class InMemoryMemoryStore implements MemoryStore {
  private items: BrainItem[] = [];
  private bySource = new Map<string, string>(); // orgId|connector|externalId -> itemId

  getBySource(orgId: string, connector: string, externalId: string): BrainItem | undefined {
    const key = `${orgId}|${connector}|${externalId}`;
    const id = this.bySource.get(key);
    if (id === undefined) return undefined;
    return this.items.find((i) => i.id === id);
  }

  get(id: string): BrainItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  insert(item: BrainItem): void {
    this.items.push(item);
    const key = `${item.orgId}|${item.source.connector}|${item.source.externalId}`;
    this.bySource.set(key, item.id);
  }

  update(item: BrainItem): void {
    const idx = this.items.findIndex((i) => i.id === item.id);
    if (idx !== -1) this.items[idx] = item;
  }

  allByOrg(orgId: string): BrainItem[] {
    return this.items.filter((i) => i.orgId === orgId);
  }
}

export interface IngestInput {
  orgId: string;
  source: SourceRef;
  title: string;
  content: string;
  type?: MemoryType;
  sourceAcl?: SourceAcl;
}

export interface IngestResult {
  ingestionRunId: string;
  itemId: string;
  deduped: boolean;
}

export interface SearchOptions {
  orgId: string;
  query: string;
  topK?: number;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
  type: MemoryType;
  source: SourceRef; // provenance (FR-3 + FR-8.6)
}

export interface WriteMemoryInput {
  orgId: string;
  type: MemoryType;
  title: string;
  content: string;
  source: SourceRef;
  confidence: number;
  visibility?: string[];
  relatedPeople?: string[];
  relatedProjects?: string[];
  supersedes?: string;
}

export type WriteMemoryResult =
  | { status: "written"; memory: MemoryObject }
  | { status: "needs_approval"; reason: string; draft: WriteMemoryInput }
  | { status: "rejected"; reason: string };

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function bag(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [k, v] of a) dot += v * (b.get(k) ?? 0);
  const mag = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  const denom = mag(a) * mag(b);
  return denom === 0 ? 0 : dot / denom;
}

export class BrainService {
  constructor(
    private authz: AuthzEngine,
    private audit?: AuditSink,
    private store: MemoryStore = new InMemoryMemoryStore(),
    /** Optional real embedder; when set, search scores with vector cosine. */
    private embedder?: Embedder,
    /** Optional temporal memory graph (FR-3.3); when set, ingest indexes episodes. */
    private graph?: MemoryGraph,
    /** Entity/relation extractor for the graph; defaults to the deterministic one. */
    private extractor: EntityExtractor = new DeterministicExtractor()
  ) {}

  /**
   * Index a document/episode into the temporal memory graph (FR-3.3). Async
   * because a real extractor calls a model; a no-op when no graph is wired.
   * Kept separate from the sync `ingest` so the ingest path stays synchronous.
   */
  async indexEpisode(input: {
    orgId: string;
    text: string;
    at: string;
    source?: SourceRef;
    seedEntities?: { name: string; type: string }[];
  }): Promise<{ entities: number; facts: number } | undefined> {
    if (!this.graph) return undefined;
    return this.graph.addEpisode(
      { orgId: input.orgId, text: input.text, at: input.at, source: input.source, seedEntities: input.seedEntities },
      this.extractor
    );
  }

  /** Time-travel query over the graph: facts touching an entity, as of an event time. */
  graphNeighbors(orgId: string, name: string, q?: NeighborQuery): GraphEdge[] {
    return this.graph?.neighbors(orgId, name, q) ?? [];
  }

  graphEntities(orgId: string): GraphEntity[] {
    return this.graph?.entitiesByOrg(orgId) ?? [];
  }

  private brainObject(orgId: string): string {
    return `brain:${orgId}`;
  }

  private register(item: BrainItem): void {
    // tie the item to its brain for permission-aware retrieval (FR-3.5)
    this.authz.write({
      subject: this.brainObject(item.orgId),
      relation: "parent",
      object: `memory_object:${item.id}`
    });
  }

  ingest(input: IngestInput): IngestResult {
    const ingestionRunId = newId("run");
    const existing = this.store.getBySource(input.orgId, input.source.connector, input.source.externalId);
    if (existing) {
      // idempotent re-ingest (NFR-3): update content in place, no duplicate
      existing.content = input.content;
      existing.title = input.title;
      existing.sourceAcl = input.sourceAcl;
      this.store.update(existing);
      return { ingestionRunId, itemId: existing.id, deduped: true };
    }
    const item: BrainItem = {
      id: newId("mem"),
      orgId: input.orgId,
      kind: "doc",
      type: input.type ?? "document",
      title: input.title,
      content: input.content,
      source: { ...input.source, ingestionRunId },
      sourceAcl: input.sourceAcl,
      confidence: 1,
      timestamp: new Date().toISOString(),
      visibility: []
    };
    this.store.insert(item);
    this.register(item);
    return { ingestionRunId, itemId: item.id, deduped: false };
  }

  /** Hybrid retrieval (vector+keyword+recency) with permission filter. */
  async search(principal: Principal, opts: SearchOptions): Promise<SearchHit[]> {
    const qTokens = tokenize(opts.query);
    const qBag = bag(qTokens);
    const qSet = new Set(qTokens);
    const now = Date.now();
    const candidates = this.store.allByOrg(opts.orgId).filter(
      (i) =>
        !i.supersededBy &&
        (!i.expiresAt || Date.parse(i.expiresAt) > now)
    );

    const visible: BrainItem[] = [];
    for (const i of candidates) {
      if (await this.canView(principal, i)) visible.push(i);
    }

    // Real vector path: when an Embedder is wired, embed the query + any visible
    // items missing a cached embedding (one batched call), then score with
    // cosine over dense vectors. Falls back to bag-of-words below otherwise.
    let queryVec: number[] | undefined;
    if (this.embedder && visible.length > 0) {
      const missing = visible.filter((i) => !i.embedding);
      if (missing.length > 0) {
        const vecs = await this.embedder.embed(missing.map((i) => `${i.title}\n${i.content}`));
        missing.forEach((it, idx) => {
          const v = vecs[idx];
          if (v) {
            it.embedding = v;
            this.store.update(it);
          }
        });
      }
      const [qv] = await this.embedder.embed([opts.query]);
      queryVec = qv;
    }

    const scored = visible.map((i) => {
      let vec: number;
      if (queryVec && i.embedding) {
        vec = cosineVec(queryVec, i.embedding);
      } else {
        const cBag = bag(tokenize(`${i.title} ${i.content}`));
        vec = cosine(qBag, cBag);
      }
      const contentSet = new Set(tokenize(`${i.title} ${i.content}`));
      let overlap = 0;
      for (const t of qSet) if (contentSet.has(t)) overlap++;
      const keyword = qSet.size ? overlap / qSet.size : 0;
      const ageDays = (now - Date.parse(i.timestamp)) / 86_400_000;
      const recency = 1 / (1 + Math.max(0, ageDays));
      const score = 0.6 * vec + 0.3 * keyword + 0.1 * recency;
      return { i, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0)
      .slice(0, opts.topK ?? 5)
      .map(({ i, score }) => ({
        id: i.id,
        title: i.title,
        snippet: i.content.slice(0, 200),
        score: Number(score.toFixed(4)),
        type: i.type,
        source: i.source
      }));
  }

  private async canView(principal: Principal, item: BrainItem): Promise<boolean> {
    // OpenFGA relation check AND captured source-ACL intersection (docs/04 §2)
    const allowedByFga = await this.authz.check(principal.id, "viewer", `memory_object:${item.id}`);
    if (!allowedByFga) return false;
    return sourceAclAdmits(principal, item.sourceAcl);
  }

  async writeMemory(principal: Principal, input: WriteMemoryInput, policy: MemoryWritePolicy): Promise<WriteMemoryResult> {
    // permission: principal must be a writer on the org brain
    if (!(await this.authz.check(principal.id, "writer", this.brainObject(input.orgId)))) {
      this.recordAudit(principal, input.orgId, "memory.write", "deny");
      return { status: "rejected", reason: "not_authorized" };
    }
    if (policy.allowedTypes.length > 0 && !policy.allowedTypes.includes(input.type)) {
      return { status: "rejected", reason: `type_not_allowed:${input.type}` };
    }
    if (input.confidence < policy.minConfidence) {
      return { status: "rejected", reason: "below_min_confidence" };
    }
    if (policy.requireApprovalBelow !== undefined && input.confidence < policy.requireApprovalBelow) {
      return { status: "needs_approval", reason: "low_confidence", draft: input };
    }
    const memory = this.persist(input);
    this.recordAudit(principal, input.orgId, "memory.write", "allow", memory.id);
    return { status: "written", memory };
  }

  /** Persist an approved/auto memory (used directly after an approval resolves). */
  persist(input: WriteMemoryInput): MemoryObject {
    const item: BrainItem = {
      id: newId("mem"),
      orgId: input.orgId,
      kind: "memory",
      type: input.type,
      title: input.title,
      content: input.content,
      source: input.source,
      confidence: input.confidence,
      timestamp: new Date().toISOString(),
      visibility: input.visibility ?? []
    };
    if (input.supersedes) {
      const prev = this.store.get(input.supersedes);
      if (prev) {
        prev.supersededBy = item.id;
        this.store.update(prev);
      }
    }
    this.store.insert(item);
    this.register(item);
    return MemoryObject.parse({
      id: item.id,
      orgId: item.orgId,
      type: item.type,
      title: item.title,
      content: item.content,
      source: item.source,
      timestamp: item.timestamp,
      confidence: item.confidence,
      visibility: item.visibility,
      relatedPeople: input.relatedPeople ?? [],
      relatedProjects: input.relatedProjects ?? [],
      supersedes: input.supersedes
    });
  }

  expire(id: string): void {
    const it = this.store.get(id);
    if (it) {
      it.expiresAt = new Date(Date.now() - 1000).toISOString();
      this.store.update(it);
    }
  }

  /** Data lineage: trace a memory back to its source (FR-8.6). */
  lineage(id: string): { id: string; source: SourceRef } | undefined {
    const it = this.store.get(id);
    return it ? { id: it.id, source: it.source } : undefined;
  }

  count(orgId: string): number {
    return this.store.allByOrg(orgId).filter((i) => !i.supersededBy).length;
  }

  private recordAudit(p: Principal, orgId: string, action: string, decision: "allow" | "deny", resourceId = orgId) {
    this.audit?.append(
      makeAuditRecord({
        orgId,
        actor: { type: p.type, id: p.id },
        action,
        resource: { type: "memory_object", id: resourceId },
        decision
      })
    );
  }
}
