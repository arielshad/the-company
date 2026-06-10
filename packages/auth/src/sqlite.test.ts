import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuthz } from "./sqlite.js";

/** The SQLite engine must satisfy the SAME relation semantics as InMemoryAuthz. */
function seeded(path?: string): SqliteAuthz {
  const fga = new SqliteAuthz(path);
  fga.write({ subject: "user:alice", relation: "admin", object: "org:acme" });
  fga.write({ subject: "user:bob", relation: "member", object: "org:acme" });
  fga.write({ subject: "org:acme", relation: "parent", object: "brain:acme" });
  fga.write({ subject: "brain:acme", relation: "parent", object: "memory_object:m1" });
  return fga;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SqliteAuthz — same ReBAC semantics as in-memory", () => {
  it("org admin is brain writer + reader; member is reader only", async () => {
    const fga = seeded();
    expect(await fga.check("user:alice", "writer", "brain:acme")).toBe(true);
    expect(await fga.check("user:alice", "reader", "brain:acme")).toBe(true);
    expect(await fga.check("user:bob", "reader", "brain:acme")).toBe(true);
    expect(await fga.check("user:bob", "writer", "brain:acme")).toBe(false);
    fga.close();
  });

  it("derives memory_object viewer from brain reader", async () => {
    const fga = seeded();
    expect(await fga.check("user:bob", "viewer", "memory_object:m1")).toBe(true);
    expect(await fga.check("user:carol", "viewer", "memory_object:m1")).toBe(false);
    fga.close();
  });

  it("resolves userset tuples (team#member → brain reader)", async () => {
    const fga = new SqliteAuthz();
    fga.write({ subject: "user:carol", relation: "member", object: "team:eng" });
    fga.write({ subject: "team:eng#member", relation: "reader", object: "brain:eng" });
    expect(await fga.check("user:carol", "reader", "brain:eng")).toBe(true);
    expect(await fga.check("user:dan", "reader", "brain:eng")).toBe(false);
    fga.close();
  });

  it("delete revokes access", async () => {
    const fga = seeded();
    expect(await fga.check("user:bob", "reader", "brain:acme")).toBe(true);
    fga.delete({ subject: "user:bob", relation: "member", object: "org:acme" });
    expect(await fga.check("user:bob", "reader", "brain:acme")).toBe(false);
    fga.close();
  });
});

describe("SqliteAuthz — durability", () => {
  it("persists tuples across a reopen (process restart)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fga-"));
    tmpDirs.push(dir);
    const path = join(dir, "authz.db");

    const first = seeded(path);
    expect(await first.check("user:alice", "writer", "brain:acme")).toBe(true);
    first.close();

    // reopen a fresh engine against the same file — relations survive
    const reopened = new SqliteAuthz(path);
    expect(await reopened.check("user:alice", "writer", "brain:acme")).toBe(true);
    expect(await reopened.check("user:bob", "reader", "brain:acme")).toBe(true);
    reopened.close();
  });
});
