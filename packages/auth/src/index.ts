/**
 * Authorization core (docs/04-mcp-and-governance.md §2, ADR-0005).
 *
 * A compact in-memory ReBAC engine mirroring infra/platform/openfga/model.fga.
 * In production this is OpenFGA; the engine here is interface-compatible
 * (write tuples / check relations) so the gateway and services can depend on
 * `AuthzEngine` and swap the backend without code changes.
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

interface AuthzModel {
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

export interface AuthzEngine {
  write(t: Tuple): void;
  delete(t: Tuple): void;
  check(subject: string, relation: string, object: string): boolean;
}

export class InMemoryAuthz implements AuthzEngine {
  private tuples = new Set<string>();
  constructor(private model: AuthzModel = COMPANYOS_MODEL) {}

  private key(t: Tuple): string {
    return `${t.subject}|${t.relation}|${t.object}`;
  }

  write(t: Tuple): void {
    this.tuples.add(this.key(t));
  }
  delete(t: Tuple): void {
    this.tuples.delete(this.key(t));
  }

  /** Direct tuples for (relation, object). */
  private subjectsFor(relation: string, object: string): string[] {
    const out: string[] = [];
    const suffix = `|${relation}|${object}`;
    for (const k of this.tuples) if (k.endsWith(suffix)) out.push(k.slice(0, k.length - suffix.length));
    return out;
  }

  /** Objects reachable from `object` via `tupleset` relation (e.g. parent). */
  private tuplesetTargets(object: string, tupleset: string): string[] {
    // tuple: object  has  tupleset  -> targetObject, stored as subject=targetObject
    // Represented as: write({subject: parentObject, relation: tupleset, object})
    return this.subjectsFor(tupleset, object);
  }

  check(subject: string, relation: string, object: string, seen = new Set<string>()): boolean {
    const guard = `${subject}|${relation}|${object}`;
    if (seen.has(guard)) return false;
    seen.add(guard);

    const rewrites = this.model[typeOf(object)]?.[relation];
    if (!rewrites) {
      // unknown relation: only direct tuple match
      return this.subjectsFor(relation, object).includes(subject);
    }

    for (const rw of rewrites) {
      if (rw.kind === "this") {
        if (this.directOrUserset(subject, relation, object, seen)) return true;
      } else if (rw.kind === "computed") {
        if (this.check(subject, rw.relation, object, seen)) return true;
      } else if (rw.kind === "tupleToUserset") {
        for (const target of this.tuplesetTargets(object, rw.tupleset)) {
          if (this.check(subject, rw.computedRelation, target, seen)) return true;
        }
      }
    }
    return false;
  }

  /** Direct membership including userset tuples like "team:eng#member". */
  private directOrUserset(subject: string, relation: string, object: string, seen: Set<string>): boolean {
    for (const s of this.subjectsFor(relation, object)) {
      if (s === subject) return true;
      // userset reference: "team:eng#member" → subject must satisfy that relation
      const hash = s.indexOf("#");
      if (hash > 0) {
        const usObject = s.slice(0, hash);
        const usRelation = s.slice(hash + 1);
        if (this.check(subject, usRelation, usObject, seen)) return true;
      }
    }
    return false;
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
