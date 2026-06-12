import { describe, it, expect } from "vitest";
import { seedAcme, alice, ORG } from "@companyos/testing";
import { BrainService } from "./index.js";
import { InMemoryMemoryGraph, DeterministicExtractor, type EntityExtractor } from "./graph.js";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";
const T3 = "2026-06-01T00:00:00.000Z";

describe("InMemoryMemoryGraph — bitemporal facts", () => {
  it("upserts entities and tracks first/last seen", () => {
    const g = new InMemoryMemoryGraph();
    g.upsertEntity(ORG, "Globex", "org", T2);
    const e = g.upsertEntity(ORG, "Globex", "org", T1); // earlier event
    expect(e.firstSeen).toBe(T1);
    expect(e.lastSeen).toBe(T2);
    expect(g.entitiesByOrg(ORG)).toHaveLength(1);
  });

  it("a new fact about the same (subject,predicate) supersedes the prior one", () => {
    const g = new InMemoryMemoryGraph();
    g.assertFact({ orgId: ORG, subject: "SSO epic", predicate: "status", object: "planned", at: T1 });
    g.assertFact({ orgId: ORG, subject: "SSO epic", predicate: "status", object: "in_progress", at: T2 });
    g.assertFact({ orgId: ORG, subject: "SSO epic", predicate: "status", object: "shipped", at: T3 });

    // Latest state (no asOf) → only the current fact.
    const latest = g.neighbors(ORG, "SSO epic");
    expect(latest).toHaveLength(1);
    expect(latest[0]?.object).toBe("shipped");

    // Time-travel: as of T2 the status was in_progress; as of T1 it was planned.
    expect(g.neighbors(ORG, "SSO epic", { asOf: T2 })[0]?.object).toBe("in_progress");
    expect(g.neighbors(ORG, "SSO epic", { asOf: T1 })[0]?.object).toBe("planned");

    // Before any fact existed → nothing valid.
    expect(g.neighbors(ORG, "SSO epic", { asOf: "2025-01-01T00:00:00.000Z" })).toHaveLength(0);

    // History view includes all three.
    expect(g.neighbors(ORG, "SSO epic", { includeInactive: true })).toHaveLength(3);
  });

  it("re-asserting the identical triple is idempotent", () => {
    const g = new InMemoryMemoryGraph();
    const a = g.assertFact({ orgId: ORG, subject: "Alice", predicate: "owns", object: "SSO epic", at: T1 });
    const b = g.assertFact({ orgId: ORG, subject: "Alice", predicate: "owns", object: "SSO epic", at: T2 });
    expect(a.id).toBe(b.id);
    expect(g.neighbors(ORG, "Alice")).toHaveLength(1);
  });

  it("neighbors are reachable from either endpoint and filter by predicate", () => {
    const g = new InMemoryMemoryGraph();
    g.assertFact({ orgId: ORG, subject: "Alice", subjectType: "person", predicate: "works_on", object: "SSO epic", objectType: "project", at: T1 });
    expect(g.neighbors(ORG, "SSO epic")).toHaveLength(1); // reachable from the object side
    expect(g.neighbors(ORG, "Alice", { predicate: "works_on" })).toHaveLength(1);
    expect(g.neighbors(ORG, "Alice", { predicate: "owns" })).toHaveLength(0);
  });
});

describe("DeterministicExtractor", () => {
  it("pulls proper-noun entities and links the primary to the rest", () => {
    const ex = new DeterministicExtractor();
    const out = ex.extract("Globex approved the SSO Epic. Bob will scope SSO Epic with Globex.");
    const names = out.entities.map((e) => e.name);
    expect(names).toContain("Globex");
    expect(names).toContain("Bob");
    expect(out.edges.every((e) => e.predicate === "mentions")).toBe(true);
  });
});

describe("BrainService.indexEpisode → graph", () => {
  it("indexes an episode and answers a time-travel query", async () => {
    // A fake extractor gives us a controlled fact we can time-travel over.
    const extractor: EntityExtractor = {
      extract: () => ({
        entities: [{ name: "Globex", type: "org" }],
        edges: [{ subject: "Globex", predicate: "stage", object: "renewal" }]
      })
    };
    const graph = new InMemoryMemoryGraph();
    const brain = new BrainService(seedAcme(), undefined, undefined, undefined, graph, extractor);

    const r = await brain.indexEpisode({ orgId: ORG, text: "Globex is up for renewal", at: T1 });
    expect(r).toEqual({ entities: 1, facts: 1 });

    const facts = brain.graphNeighbors(ORG, "Globex", { asOf: T2 });
    expect(facts[0]?.object).toBe("renewal");
    expect(brain.graphEntities(ORG).some((e) => e.name === "Globex")).toBe(true);
  });

  it("is a no-op when no graph is wired", async () => {
    const brain = new BrainService(seedAcme());
    expect(await brain.indexEpisode({ orgId: ORG, text: "x", at: T1 })).toBeUndefined();
    expect(brain.graphNeighbors(ORG, "x")).toEqual([]);
  });

  // alice/seedAcme imported to keep the brain construction consistent with other suites.
  it("graph stays scoped per org", async () => {
    const graph = new InMemoryMemoryGraph();
    const brain = new BrainService(seedAcme(), undefined, undefined, undefined, graph, new DeterministicExtractor());
    await brain.indexEpisode({ orgId: ORG, text: "Globex Renewal", at: T1 });
    expect(brain.graphEntities("other-org")).toHaveLength(0);
    expect(alice.orgId).toBe(ORG);
  });
});
