import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainService } from "./index.js";
import { SqliteMemoryStore } from "./sqlite.js";
import { SqliteAuthz } from "@companyos/auth/sqlite";
import { seedAcme, alice, ORG } from "@companyos/testing";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const policy = { allowedTypes: ["decision" as const], minConfidence: 0.5 };

describe("BrainService — SQLite store", () => {
  it("search + permission work on the SQLite store", async () => {
    const brain = new BrainService(seedAcme(), undefined, new SqliteMemoryStore());
    brain.ingest({
      orgId: ORG,
      source: { connector: "notion", externalId: "doc1" },
      title: "Onboarding Guide",
      content: "Public onboarding guide for all new employees."
    });
    const hits = await brain.search(alice, { orgId: ORG, query: "onboarding guide" });
    expect(hits.some((h) => h.title === "Onboarding Guide")).toBe(true);
  });

  it("brain persists across a restart (durable authz + memory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-"));
    tmpDirs.push(dir);
    const authzPath = join(dir, "authz.db");
    const memPath = join(dir, "memory.db");

    // --- first session ---
    const authz = new SqliteAuthz(authzPath);
    authz.write({ subject: "user:alice", relation: "admin", object: "org:acme" });
    authz.write({ subject: `org:${ORG}`, relation: "parent", object: `brain:${ORG}` });

    const store = new SqliteMemoryStore(memPath);
    const brain = new BrainService(authz, undefined, store);

    const result = await brain.writeMemory(
      alice,
      {
        orgId: ORG,
        type: "decision",
        title: "Prioritize SSO",
        content: "We will prioritize SSO for August.",
        source: { connector: "zoom", externalId: "m1" },
        confidence: 0.95
      },
      policy
    );
    expect(result.status).toBe("written");
    expect(brain.count(ORG)).toBe(1);

    authz.close();
    store.close();

    // --- second session (simulated restart) ---
    const authz2 = new SqliteAuthz(authzPath);
    const store2 = new SqliteMemoryStore(memPath);
    const brain2 = new BrainService(authz2, undefined, store2);

    expect(brain2.count(ORG)).toBe(1);
    const hits = await brain2.search(alice, { orgId: ORG, query: "prioritize SSO August" });
    expect(hits.length).toBeGreaterThanOrEqual(1);

    authz2.close();
    store2.close();
  });
});
