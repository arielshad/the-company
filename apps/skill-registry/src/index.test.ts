import { describe, it, expect } from "vitest";
import { SkillRegistry, validatePackage, type SkillPackage } from "./index.js";

const goodPkg: SkillPackage = {
  SKILL_md: "# Qualify Lead\nDoes things.",
  tools_json: { inputSchema: { type: "object" }, outputSchema: { type: "object" }, requiredTools: ["brain.search"] },
  evals_yaml: { evals: ["source_coverage"], thresholds: { source_coverage: 0.7 }, gate: "block" }
};

function reg() {
  return new SkillRegistry();
}
const base = { orgId: "acme", name: "qualify-lead", owner: "sales", source: "github" as const, sourceRef: "skills/sales/qualify-lead", allowedRoles: ["sales", "admin"] };

describe("validatePackage", () => {
  it("accepts a complete package", () => {
    expect(validatePackage(goodPkg).valid).toBe(true);
  });
  it("rejects an incomplete package", () => {
    const r = validatePackage({ SKILL_md: "x" });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("missing tools.json");
  });
});

describe("register & sync", () => {
  it("registers a draft skill and records changelog", () => {
    const r = reg();
    const s = r.register(base, goodPkg);
    expect(s.status).toBe("draft");
    expect(s.changelog[0]).toContain("registered");
  });
  it("throws on invalid package", () => {
    expect(() => reg().register(base, { SKILL_md: "x" })).toThrow(/invalid skill package/);
  });
  it("sync creates a new changelog entry", () => {
    const r = reg();
    const s = r.register(base, goodPkg);
    const v2 = r.sync(s.id, { version: "0.2.0", description: "updated" }, "notion edit");
    expect(v2.changelog.at(-1)).toContain("notion edit");
  });
  it("filters by role", () => {
    const r = reg();
    r.register(base, goodPkg);
    expect(r.list("acme", { role: "engineering" })).toHaveLength(0);
    expect(r.list("acme", { role: "sales" })).toHaveLength(1);
  });
});

describe("promotion gate (FR-5.7)", () => {
  it("promotes to active when evals pass", () => {
    const r = reg();
    const s = r.register(base, goodPkg);
    const res = r.promote(s.id, {
      claims: ["prioritize SSO"],
      citations: [{ sourceRef: "z", quote: "we will prioritize SSO" }]
    });
    expect(res.promoted).toBe(true);
    expect(r.get(s.id)?.status).toBe("active");
  });

  it("blocks promotion when evals fail", () => {
    const r = reg();
    const s = r.register(base, goodPkg);
    const res = r.promote(s.id, { claims: ["uncited claim"], citations: [] });
    expect(res.promoted).toBe(false);
    expect(res.failures).toContain("source_coverage");
    expect(r.get(s.id)?.status).toBe("draft");
  });
});
