import { describe, it, expect } from "vitest";
import {
  InMemoryAuthz,
  principalFromClaims,
  sourceAclAdmits,
  type Principal
} from "./index.js";

describe("InMemoryAuthz ReBAC", () => {
  function setup() {
    const fga = new InMemoryAuthz();
    // org relations
    fga.write({ subject: "user:alice", relation: "admin", object: "org:acme" });
    fga.write({ subject: "user:bob", relation: "member", object: "org:acme" });
    // brain belongs to org
    fga.write({ subject: "org:acme", relation: "parent", object: "brain:acme" });
    // memory object belongs to brain
    fga.write({ subject: "brain:acme", relation: "parent", object: "memory_object:m1" });
    return fga;
  }

  it("org admin is a brain writer and reader (via parent)", () => {
    const fga = setup();
    expect(fga.check("user:alice", "writer", "brain:acme")).toBe(true);
    expect(fga.check("user:alice", "reader", "brain:acme")).toBe(true);
  });

  it("org member is a brain reader but not a writer", () => {
    const fga = setup();
    expect(fga.check("user:bob", "reader", "brain:acme")).toBe(true);
    expect(fga.check("user:bob", "writer", "brain:acme")).toBe(false);
  });

  it("memory_object viewer is derived from brain reader", () => {
    const fga = setup();
    expect(fga.check("user:bob", "viewer", "memory_object:m1")).toBe(true);
    expect(fga.check("user:carol", "viewer", "memory_object:m1")).toBe(false);
  });

  it("resolves userset tuples (team#member granted brain reader)", () => {
    const fga = new InMemoryAuthz();
    fga.write({ subject: "user:carol", relation: "member", object: "team:eng" });
    fga.write({ subject: "team:eng#member", relation: "reader", object: "brain:eng" });
    expect(fga.check("user:carol", "reader", "brain:eng")).toBe(true);
    expect(fga.check("user:dan", "reader", "brain:eng")).toBe(false);
  });

  it("team membership inherits from parent org", () => {
    const fga = new InMemoryAuthz();
    fga.write({ subject: "user:erin", relation: "member", object: "org:acme" });
    fga.write({ subject: "org:acme", relation: "parent", object: "team:eng" });
    expect(fga.check("user:erin", "member", "team:eng")).toBe(true);
  });

  it("delete revokes access", () => {
    const fga = setup();
    expect(fga.check("user:bob", "reader", "brain:acme")).toBe(true);
    fga.delete({ subject: "user:bob", relation: "member", object: "org:acme" });
    expect(fga.check("user:bob", "reader", "brain:acme")).toBe(false);
  });
});

describe("principalFromClaims", () => {
  it("maps a user with roles and groups", () => {
    const p = principalFromClaims({
      sub: "alice",
      org_id: "acme",
      realm_access: { roles: ["member", "builder"] },
      groups: ["leadership"]
    });
    expect(p).toMatchObject({ type: "user", id: "user:alice", orgId: "acme" });
    expect(p.groups).toEqual(["leadership"]);
  });

  it("detects an agent principal", () => {
    const p = principalFromClaims({ sub: "bot1", org_id: "acme", realm_access: { roles: ["agent"] } });
    expect(p.type).toBe("agent");
    expect(p.id).toBe("agent:bot1");
  });

  it("detects a service principal", () => {
    const p = principalFromClaims({
      sub: "service-account-gateway",
      azp: "companyos-gateway",
      org_id: "acme",
      realm_access: { roles: [] }
    });
    expect(p.type).toBe("service");
  });
});

describe("sourceAclAdmits", () => {
  const alice: Principal = { type: "user", id: "user:alice", orgId: "acme", roles: [], groups: ["leadership"] };
  const bob: Principal = { type: "user", id: "user:bob", orgId: "acme", roles: [], groups: ["eng"] };

  it("admits by group membership", () => {
    expect(sourceAclAdmits(alice, { allow: ["group:leadership"] })).toBe(true);
    expect(sourceAclAdmits(bob, { allow: ["group:leadership"] })).toBe(false);
  });

  it("admits by direct identity", () => {
    expect(sourceAclAdmits(bob, { allow: ["user:bob"] })).toBe(true);
  });

  it("admits public and absent ACLs", () => {
    expect(sourceAclAdmits(bob, { allow: [], public: true })).toBe(true);
    expect(sourceAclAdmits(bob, undefined)).toBe(true);
  });
});
