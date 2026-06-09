import { describe, it, expect } from "vitest";
import { Agent, MemoryObject, Skill, AuditRecord, newId } from "./index.js";

describe("schemas", () => {
  it("applies Agent defaults and round-trips", () => {
    const a = Agent.parse({ id: "a1", orgId: "acme", name: "Ada", role: "Engineer" });
    expect(a.status).toBe("active");
    expect(a.modelProvider).toBe("anthropic");
    expect(a.budgetMonthlyUsd).toBe(0);
    expect(a.approvalPolicy.onTimeout).toBe("escalate");
    expect(Agent.parse(a)).toEqual(a);
  });

  it("rejects an Agent without required fields", () => {
    expect(() => Agent.parse({ id: "a1" })).toThrow();
  });

  it("validates MemoryObject confidence bounds", () => {
    const valid = {
      id: "m1",
      orgId: "acme",
      type: "decision",
      title: "Ship v1",
      content: "We will ship.",
      source: { connector: "zoom", externalId: "z1" },
      timestamp: new Date().toISOString(),
      confidence: 0.9
    };
    expect(MemoryObject.parse(valid).type).toBe("decision");
    expect(() => MemoryObject.parse({ ...valid, confidence: 1.5 })).toThrow();
  });

  it("rejects unknown memory type", () => {
    expect(() =>
      MemoryObject.parse({
        id: "m1",
        orgId: "acme",
        type: "gossip",
        title: "x",
        content: "",
        source: { connector: "c", externalId: "e" },
        timestamp: "now",
        confidence: 0.5
      })
    ).toThrow();
  });

  it("defaults Skill to draft", () => {
    const s = Skill.parse({
      id: "s1",
      orgId: "acme",
      name: "qualify-lead",
      owner: "sales",
      source: "github",
      sourceRef: "skills/sales/qualify-lead"
    });
    expect(s.status).toBe("draft");
    expect(s.approvalRequired).toBe(false);
  });

  it("validates AuditRecord shape", () => {
    const r = AuditRecord.parse({
      id: "r1",
      orgId: "acme",
      ts: new Date().toISOString(),
      actor: { type: "agent", id: "a1" },
      action: "tool.call",
      resource: { type: "brain", id: "b1" },
      traceId: "t1",
      decision: "allow"
    });
    expect(r.metadata).toEqual({});
  });

  it("newId is prefixed and unique-ish", () => {
    const a = newId("ag");
    const b = newId("ag");
    expect(a.startsWith("ag_")).toBe(true);
    expect(a).not.toEqual(b);
  });
});
