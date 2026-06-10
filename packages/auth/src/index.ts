/**
 * Authorization core (docs/04-mcp-and-governance.md §2, ADR-0005).
 *
 * A compact ReBAC engine mirroring infra/platform/openfga/model.fga. The check
 * algorithm is separated from tuple *storage* via `TupleStore`, so the same
 * (tested) semantics back both the in-memory store and the durable SQLite store
 * (`@companyos/auth/sqlite`). In production this is OpenFGA; the engine here is
 * interface-compatible so the gateway and services depend only on `AuthzEngine`.
 */

export type SubjectKind = "user" | "agent" | "service";

export interface Principal {
  type: SubjectKind;
  id: string; // e.g. "user:alice"
  orgId: string;
  roles: string[]; // realm roles from Keycloak (owner/admin/builder/member/auditor/agent)
  groups: string[]; // e.g. ["leadership"]
}

/** A relationship tuple: subject has `relation` on `object`. */
export interface Tuple {
  subject: string; // "user:alice" | "agent:bot" | "team:eng#member" (userset)
  relation: string;
  object: string; // "brain:acme" | "org:acme" | "memory_object:m1"
}

/** Userset rewrite primitives (a small subset of OpenFGA semantics). */
type Rewrite =
  | { kind: "this" }
  | { kind: "computed"; relation: string }
  | { kind: "tupleToUserset"; tupleset: string; computedRelation: string };

interface TypeModel {
  [relation: string]: Rewrite[]; // union of rewrites
}

export interface AuthzModel {
  [type: string]: TypeModel;
}

/** The CompanyOS model (kept in sync with model.fga). */
export const COMPANYOS_MODEL: AuthzModel = {
  org: {
    owner: [{ kind: "this" }],
    admin: [{ kind: "this" }, { kind: "computed", relation: "owner" }],
    auditor: [{ kind: "this" }],
    member: [{ kind: "this" }, { kind: "computed", relation: "admin" }]
  },
  team: {
    parent: [{ kind: "this" }],
    lead: [{ kind: "this" }],
    member: [
      { kind: "this" },
      { kind: "computed", relation: "lead" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "member" }
    ]
  },
  brain: {
    parent: [{ kind: "this" }],
    writer: [
      { kind: "this" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "admin" }
    ],
    reader: [
      { kind: "this" },
      { kind: "computed", relation: "writer" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "member" }
    ]
  },
  memory_object: {
    parent: [{ kind: "this" }],
    viewer: [{ kind: "tupleToUserset", tupleset: "parent", computedRelation: "reader" }],
    editor: [{ kind: "tupleToUserset", tupleset: "parent", computedRelation: "writer" }]
  },
  skill: {
    parent: [{ kind: "this" }],
    editor: [
      { kind: "this" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "admin" }
    ],
    runner: [{ kind: "this" }, { kind: "computed", relation: "editor" }]
  },
  workflow: {
    parent: [{ kind: "this" }],
    editor: [
      { kind: "this" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "admin" }
    ],
    trigger: [{ kind: "this" }, { kind: "computed", relation: "editor" }]
  },
  tool: {
    parent: [{ kind: "this" }],
    caller: [
      { kind: "this" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "admin" }
    ]
  },
  connector: {
    parent: [{ kind: "this" }],
    admin_rel: [
      { kind: "this" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "admin" }
    ],
    user_rel: [
      { kind: "this" },
      { kind: "computed", relation: "admin_rel" },
      { kind: "tupleToUserset", tupleset: "parent", computedRelation: "member" }
    ]
  }
};

function typeOf(object: string): string {
  return object.split(":")[0]!;
}

/** Storage abstraction for relationship tuples (in-memory or durable). */
export interface TupleStore {
  add(t: Tuple): void;
  remove(t: Tuple): void;
  /** Subjects of all tuples matching (relation, object). */
  subjects(relation: string, object: string): string[];
}

/**
 * Evaluate whether `subject` has `relation` on `object` under `model`.
 * Shared by every AuthzEngine backend so semantics are identical.
 */
export function runCheck(
  store: TupleStore,
  model: AuthzModel,
  subject: string,
  relation: string,
  object: string,
  seen = new Set<string>()
): boolean {
  const guard = `${subject}|${relation}|${object}`;
  if (seen.has(guard)) return false;
  seen.add(guard);

  const rewrites = model[typeOf(object)]?.[relation];
  if (!rewrites) {
    return store.subjects(relation, object).includes(subject);
  }

  for (const rw of rewrites) {
    if (rw.kind === "this") {
      for (const s of store.subjects(relation, object)) {
        if (s === subject) return true;
        const hash = s.indexOf("#"); // userset reference, e.g. "team:eng#member"
        if (hash > 0) {
          const usObject = s.slice(0, hash);
          const usRelation = s.slice(hash + 1);
          if (runCheck(store, model, subject, usRelation, usObject, seen)) return true;
        }
      }
    } else if (rw.kind === "computed") {
      if (runCheck(store, model, subject, rw.relation, object, seen)) return true;
    } else if (rw.kind === "tupleToUserset") {
      for (const target of store.subjects(rw.tupleset, object)) {
        if (runCheck(store, model, subject, rw.computedRelation, target, seen)) return true;
      }
    }
  }
  return false;
}

export interface AuthzEngine {
  write(t: Tuple): void | Promise<void>;
  delete(t: Tuple): void | Promise<void>;
  /** Async to accommodate networked backends (OpenFGA); in-memory/SQLite resolve immediately. */
  check(subject: string, relation: string, object: string): Promise<boolean>;
}

/** Base engine: delegates storage to a TupleStore, semantics to runCheck. */
export abstract class AbstractAuthz implements AuthzEngine {
  protected constructor(
    protected store: TupleStore,
    protected model: AuthzModel = COMPANYOS_MODEL
  ) {}
  write(t: Tuple): void {
    this.store.add(t);
  }
  delete(t: Tuple): void {
    this.store.remove(t);
  }
  async check(subject: string, relation: string, object: string): Promise<boolean> {
    return runCheck(this.store, this.model, subject, relation, object);
  }
}

export class InMemoryTupleStore implements TupleStore {
  private tuples = new Set<string>();
  private key(t: Tuple): string {
    return `${t.subject}|${t.relation}|${t.object}`;
  }
  add(t: Tuple): void {
    this.tuples.add(this.key(t));
  }
  remove(t: Tuple): void {
    this.tuples.delete(this.key(t));
  }
  subjects(relation: string, object: string): string[] {
    const suffix = `|${relation}|${object}`;
    const out: string[] = [];
    for (const k of this.tuples) if (k.endsWith(suffix)) out.push(k.slice(0, k.length - suffix.length));
    return out;
  }
}

export class InMemoryAuthz extends AbstractAuthz {
  constructor(model: AuthzModel = COMPANYOS_MODEL) {
    super(new InMemoryTupleStore(), model);
  }
}

/* ---------------- OIDC principal resolution ---------------- */

export interface OidcClaims {
  sub: string;
  org_id?: string;
  realm_access?: { roles?: string[] };
  groups?: string[];
  azp?: string; // authorized party / client id (service principals)
}

/**
 * Resolve OIDC claims (validated upstream) into a CompanyOS principal.
 * Mirrors Keycloak realm role/group claims (docs/04 §8).
 */
export function principalFromClaims(claims: OidcClaims, defaultOrg = "default"): Principal {
  const roles = claims.realm_access?.roles ?? [];
  const isAgent = roles.includes("agent");
  const isService = !!claims.azp && claims.sub.startsWith("service-account");
  const type: SubjectKind = isService ? "service" : isAgent ? "agent" : "user";
  const idPrefix = type === "service" ? "service" : type === "agent" ? "agent" : "user";
  return {
    type,
    id: `${idPrefix}:${claims.sub}`,
    orgId: claims.org_id ?? defaultOrg,
    roles,
    groups: claims.groups ?? []
  };
}

/* ---------------- Permission-aware retrieval filter (FR-3.5) ---------------- */

/** Origin permissions captured at ingest (FR-2.5). */
export interface SourceAcl {
  /** Identities/groups allowed by the source system, e.g. ["user:alice","group:leadership"]. */
  allow: string[];
  /** If true, the object is public within the org. */
  public?: boolean;
}

/**
 * A principal may see a sourced object iff the source ACL admits its identity
 * or one of its groups (intersection of OpenFGA result and source ACL).
 */
export function sourceAclAdmits(principal: Principal, acl: SourceAcl | undefined): boolean {
  if (!acl) return true; // no captured ACL → governed solely by OpenFGA
  if (acl.public) return true;
  if (acl.allow.includes(principal.id)) return true;
  return principal.groups.some((g) => acl.allow.includes(`group:${g}`));
}
