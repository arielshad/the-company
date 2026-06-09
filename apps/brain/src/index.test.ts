import { describe, it, expect, beforeEach } from "vitest";
import { BrainService } from "./index.js";
import { InMemoryAudit } from "@companyos/telemetry";
import { seedAcme, alice, bob, ORG } from "@companyos/testing";
import type { Principal } from "@companyos/auth";

const carol: Principal = { type: "user", id: "user:carol", orgId: ORG, roles: [], groups: [] };

describe("BrainService — ingestion", () => {
  it("ingests and is idempotent per source object (NFR-3)", () => {
    const brain = new BrainService(seedAcme());
    const r1 = brain.ingest({ orgId: ORG, source: { connector: "notion", externalId: "p1" }, title: "Plan", content: "roadmap" });
    const r2 = brain.ingest({ orgId: ORG, source: { connector: "notion", externalId: "p1" }, title: "Plan v2", content: "roadmap updated" });
    expect(r2.deduped).toBe(true);
    expect(r2.itemId).toBe(r1.itemId);
    expect(brain.count(ORG)).toBe(1);
  });
});

describe("BrainService — permission-aware search (FR-3.5)", () => {
  let brain: BrainService;
  beforeEach(() => {
    brain = new BrainService(seedAcme());
    // restricted to leadership group
    brain.ingest({
      orgId: ORG,
      source: { connector: "notion", externalId: "q3", url: "https://notion/q3" },
      title: "Q3 Strategy",
      content: "Confidential Q3 strategy: pricing changes and headcount plan.",
      sourceAcl: { allow: ["group:leadership"] }
    });
    // public doc
    brain.ingest({
      orgId: ORG,
      source: { connector: "github", externalId: "readme" },
      title: "Onboarding",
      content: "Public onboarding guide and strategy overview."
    });
  });

  it("hides a restricted document from an unauthorized user", () => {
    const hits = brain.search(bob, { orgId: ORG, query: "Q3 strategy" });
    expect(hits.find((h) => h.title === "Q3 Strategy")).toBeUndefined();
  });

  it("shows the restricted document to an authorized user with provenance", () => {
    const hits = brain.search(alice, { orgId: ORG, query: "Q3 strategy" });
    const hit = hits.find((h) => h.title === "Q3 Strategy");
    expect(hit).toBeDefined();
    expect(hit!.source.connector).toBe("notion");
    expect(hit!.source.url).toBe("https://notion/q3");
  });

  it("denies a non-member entirely (OpenFGA)", () => {
    const hits = brain.search(carol, { orgId: ORG, query: "strategy" });
    expect(hits).toHaveLength(0);
  });

  it("returns public docs to any member", () => {
    const hits = brain.search(bob, { orgId: ORG, query: "onboarding strategy" });
    expect(hits.some((h) => h.title === "Onboarding")).toBe(true);
  });
});

describe("BrainService — memory write (FR-3.6/3.7)", () => {
  const policy = { allowedTypes: ["decision" as const, "customer_fact" as const], minConfidence: 0.5, requireApprovalBelow: 0.8 };
  const base = {
    orgId: ORG,
    type: "decision" as const,
    title: "Prioritize SSO",
    content: "We will prioritize SSO for August.",
    source: { connector: "zoom", externalId: "m1" },
    confidence: 0.95
  };

  it("writes when authorized and policy satisfied", () => {
    const audit = new InMemoryAudit();
    const brain = new BrainService(seedAcme(), audit);
    const r = brain.writeMemory(alice, base, policy);
    expect(r.status).toBe("written");
    expect(audit.list(ORG).some((a) => a.action === "memory.write" && a.decision === "allow")).toBe(true);
  });

  it("rejects an unauthorized writer", () => {
    const brain = new BrainService(seedAcme());
    const r = brain.writeMemory(bob, base, policy); // bob is member, not writer
    expect(r).toMatchObject({ status: "rejected", reason: "not_authorized" });
  });

  it("routes low-confidence writes to approval", () => {
    const brain = new BrainService(seedAcme());
    const r = brain.writeMemory(alice, { ...base, confidence: 0.6 }, policy);
    expect(r.status).toBe("needs_approval");
  });

  it("rejects disallowed types and sub-threshold confidence", () => {
    const brain = new BrainService(seedAcme());
    expect(brain.writeMemory(alice, { ...base, type: "risk" }, policy).status).toBe("rejected");
    expect(brain.writeMemory(alice, { ...base, confidence: 0.1 }, policy).status).toBe("rejected");
  });

  it("supersede + lineage work", () => {
    const brain = new BrainService(seedAcme());
    const first = brain.persist(base);
    const second = brain.persist({ ...base, title: "Prioritize SSO (rev)", supersedes: first.id });
    // superseded item no longer surfaces in search
    const hits = brain.search(alice, { orgId: ORG, query: "prioritize SSO" });
    expect(hits.some((h) => h.id === first.id)).toBe(false);
    expect(hits.some((h) => h.id === second.id)).toBe(true);
    expect(brain.lineage(second.id)?.source.connector).toBe("zoom");
  });
});
