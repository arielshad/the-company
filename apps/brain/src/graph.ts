/**
 * Temporal memory graph (FR-3.3, "Graphiti-style").
 *
 * A bitemporal entity/edge knowledge graph: facts carry BOTH event time (when
 * the fact was true in the world — `validFrom`/`validTo`) and system time (when
 * we recorded/retracted it — `recordedAt`/`invalidatedAt`). A new fact about the
 * same (subject, predicate) supersedes the prior one (closes its `validTo`),
 * so history is preserved and "as of T" queries return the state believed at T.
 *
 * Design matches the rest of the brain: a `MemoryGraph` interface with an
 * in-memory implementation (deterministic, offline) so a graph DB (Neo4j/etc.)
 * can be swapped behind it later. Entity/relation extraction is pluggable via
 * `EntityExtractor` — a deterministic heuristic offline, a real LLM extractor
 * injected by the server (apps/core) when a key is configured.
 */
import type { SourceRef } from "@companyos/schemas";

export interface GraphEntity {
  /** Stable id: `${orgId}|${type}|${nameLower}`. */
  id: string;
  orgId: string;
  name: string;
  type: string; // person | org | project | topic | ...
  firstSeen: string; // ISO-8601 (earliest event time we saw it)
  lastSeen: string;
}

export interface GraphEdge {
  id: string;
  orgId: string;
  subjectId: string;
  predicate: string;
  /** Object as a display value (entity name or literal). */
  object: string;
  /** Object entity id when the object resolved to an entity. */
  objectId?: string;
  // --- event time (validity in the world) ---
  validFrom: string;
  validTo?: string;
  // --- system time (our record) ---
  recordedAt: string;
  invalidatedAt?: string;
  source?: SourceRef;
  confidence: number;
}

export interface ExtractedEntity {
  name: string;
  type: string;
}
export interface ExtractedEdge {
  subject: string;
  predicate: string;
  object: string;
}
export interface Extraction {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
}

/** Pluggable entity/relation extractor (deterministic offline, LLM in prod). */
export interface EntityExtractor {
  extract(text: string): Extraction | Promise<Extraction>;
}

export interface AddEpisodeInput {
  orgId: string;
  text: string;
  /** Event time of the episode (e.g. the source doc's timestamp). */
  at: string;
  source?: SourceRef;
  /** Pre-known entities (e.g. meeting participants) merged with extracted ones. */
  seedEntities?: ExtractedEntity[];
  confidence?: number;
}

export interface NeighborQuery {
  /** Event time to evaluate validity at; defaults to "now" (latest state). */
  asOf?: string;
  predicate?: string;
  /** Include superseded/expired edges (history). Default false. */
  includeInactive?: boolean;
}

export interface MemoryGraph {
  upsertEntity(orgId: string, name: string, type: string, at: string): GraphEntity;
  /**
   * Assert a fact. If an active edge with the same (subject, predicate) but a
   * DIFFERENT object exists, it is superseded (temporal update). Re-asserting the
   * exact same triple is idempotent.
   */
  assertFact(input: {
    orgId: string;
    subject: string;
    subjectType?: string;
    predicate: string;
    object: string;
    objectType?: string;
    at: string;
    source?: SourceRef;
    confidence?: number;
  }): GraphEdge;
  addEpisode(input: AddEpisodeInput, extractor: EntityExtractor): Promise<{ entities: number; facts: number }>;
  entity(orgId: string, name: string, type?: string): GraphEntity | undefined;
  entitiesByOrg(orgId: string): GraphEntity[];
  /** Facts touching an entity, evaluated at an optional event time. */
  neighbors(orgId: string, name: string, q?: NeighborQuery): GraphEdge[];
}

// Entity identity is (org, name) — NOT (org, type, name). The same real-world
// thing ("Globex") must be one node whether a generic edge calls it "entity" or
// an extractor types it "org", otherwise facts attach to split duplicates.
function entityId(orgId: string, name: string): string {
  return `${orgId}|${name.trim().toLowerCase()}`;
}

/** True when an edge's event-time validity window contains `t`. */
function activeAt(edge: GraphEdge, t: string): boolean {
  if (edge.validFrom > t) return false;
  if (edge.validTo !== undefined && t >= edge.validTo) return false;
  return true;
}

export class InMemoryMemoryGraph implements MemoryGraph {
  private entities = new Map<string, GraphEntity>();
  private edges: GraphEdge[] = [];
  private seq = 0;

  upsertEntity(orgId: string, name: string, type: string, at: string): GraphEntity {
    const id = entityId(orgId, name);
    const existing = this.entities.get(id);
    if (existing) {
      if (at < existing.firstSeen) existing.firstSeen = at;
      if (at > existing.lastSeen) existing.lastSeen = at;
      // Upgrade a generic "entity" type to a specific one when we learn it.
      if (existing.type === "entity" && type !== "entity") existing.type = type;
      return existing;
    }
    const e: GraphEntity = { id, orgId, name: name.trim(), type, firstSeen: at, lastSeen: at };
    this.entities.set(id, e);
    return e;
  }

  assertFact(input: {
    orgId: string;
    subject: string;
    subjectType?: string;
    predicate: string;
    object: string;
    objectType?: string;
    at: string;
    source?: SourceRef;
    confidence?: number;
  }): GraphEdge {
    const subjectType = input.subjectType ?? "entity";
    const subj = this.upsertEntity(input.orgId, input.subject, subjectType, input.at);
    const objType = input.objectType;
    const objEntity = objType ? this.upsertEntity(input.orgId, input.object, objType, input.at) : undefined;

    // Active edges for the same (subject, predicate).
    const samePred = this.edges.filter(
      (e) => e.orgId === input.orgId && e.subjectId === subj.id && e.predicate === input.predicate && e.invalidatedAt === undefined && e.validTo === undefined
    );
    const identical = samePred.find((e) => e.object === input.object);
    if (identical) return identical; // idempotent re-assertion

    // Different object → temporal update: close out the prior fact(s).
    for (const prior of samePred) {
      prior.validTo = input.at;
      prior.invalidatedAt = input.at;
    }

    const edge: GraphEdge = {
      id: `edge_${++this.seq}`,
      orgId: input.orgId,
      subjectId: subj.id,
      predicate: input.predicate,
      object: input.object,
      objectId: objEntity?.id,
      validFrom: input.at,
      recordedAt: input.at,
      source: input.source,
      confidence: input.confidence ?? 1
    };
    this.edges.push(edge);
    return edge;
  }

  async addEpisode(input: AddEpisodeInput, extractor: EntityExtractor): Promise<{ entities: number; facts: number }> {
    const ex = await extractor.extract(input.text);
    const allEntities = [...(input.seedEntities ?? []), ...ex.entities];
    for (const e of allEntities) this.upsertEntity(input.orgId, e.name, e.type, input.at);
    let facts = 0;
    for (const edge of ex.edges) {
      this.assertFact({
        orgId: input.orgId,
        subject: edge.subject,
        predicate: edge.predicate,
        object: edge.object,
        at: input.at,
        source: input.source,
        confidence: input.confidence
      });
      facts++;
    }
    return { entities: allEntities.length, facts };
  }

  entity(orgId: string, name: string, _type?: string): GraphEntity | undefined {
    return this.entities.get(entityId(orgId, name));
  }

  entitiesByOrg(orgId: string): GraphEntity[] {
    return [...this.entities.values()].filter((e) => e.orgId === orgId);
  }

  neighbors(orgId: string, name: string, q: NeighborQuery = {}): GraphEdge[] {
    const ent = this.entity(orgId, name);
    if (!ent) return [];
    return this.edges.filter((e) => {
      if (e.orgId !== orgId) return false;
      if (e.subjectId !== ent.id && e.objectId !== ent.id) return false;
      if (q.predicate && e.predicate !== q.predicate) return false;
      if (!q.includeInactive) {
        if (q.asOf !== undefined) {
          if (!activeAt(e, q.asOf)) return false;
        } else if (e.validTo !== undefined || e.invalidatedAt !== undefined) {
          return false; // latest state only
        }
      }
      return true;
    });
  }
}

/**
 * Deterministic offline extractor: pulls proper-noun entities (capitalized word
 * runs) and links the document's primary entity to the others via a generic
 * `mentions` predicate. Not semantic — it just keeps the graph populated and
 * tests offline; the real entity/relation extraction is the LLM extractor that
 * apps/core injects when a key is configured.
 */
const STOPWORDS = new Set(["The", "A", "An", "We", "I", "It", "This", "That", "Our", "Their"]);

export class DeterministicExtractor implements EntityExtractor {
  extract(text: string): Extraction {
    const matches = text.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g) ?? [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      if (STOPWORDS.has(m)) continue;
      const key = m.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(m);
    }
    const entities: ExtractedEntity[] = names.map((n) => ({ name: n, type: "entity" }));
    const edges: ExtractedEdge[] = [];
    const [primary, ...rest] = names;
    if (primary) {
      for (const other of rest) edges.push({ subject: primary, predicate: "mentions", object: other });
    }
    return { entities, edges };
  }
}
