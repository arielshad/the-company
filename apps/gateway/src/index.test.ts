import { describe, it, expect } from "vitest";
import { McpGateway } from "./index.js";
import { BrainService } from "@companyos/brain";
import { GovernanceService } from "@companyos/governance";
import { WorkflowEngine } from "@companyos/workflow-engine";
import { SkillRegistry } from "@companyos/skill-registry";
import { InMemoryAudit, BudgetTracker } from "@companyos/telemetry";
import { seedAcme, ORG } from "@companyos/testing";

function setup() {
  const authz = seedAcme();
  const audit = new InMemoryAudit();
  const brain = new BrainService(authz, audit);
  const governance = new GovernanceService(authz, audit, new BudgetTracker());
  const engine = new WorkflowEngine({ brain, governance });
  const skills = new SkillRegistry();
  const gateway = new McpGateway({ authz, governance, brain, engine, skills, getWorkflow: () => undefined });
  return { authz, audit, brain, gateway };
}

describe("McpGateway — authn & policy-filtered catalog (FR-7.2/7.3)", () => {
  it("admin sees brain.write; plain reader does not", () => {
    const { gateway } = setup();
    const admin = gateway.authenticate({ sub: "alice", org_id: ORG, realm_access: { roles: ["admin"] } });
    // alice is org admin in seedAcme → writer
    expect(gateway.listTools(admin).map((t) => t.name)).toContain("brain.write");

    const stranger = gateway.authenticate({ sub: "zzz", org_id: ORG, realm_access: { roles: [] } });
    expect(gateway.listTools(stranger)).toHaveLength(0); // not a member of acme
  });
});

describe("McpGateway — authorized tool calls (FR-7.4)", () => {
  it("allows brain.search for a member and audits it", async () => {
    const { gateway, brain, audit } = setup();
    brain.ingest({ orgId: ORG, source: { connector: "notion", externalId: "d1" }, title: "Doc", content: "SSO roadmap August" });
    const bob = gateway.authenticate({ sub: "bob", org_id: ORG, realm_access: { roles: ["member"] } });
    const res = await gateway.callTool(bob, "brain.search", { query: "SSO" });
    expect(res.ok).toBe(true);
    expect((res.result as any[]).length).toBeGreaterThan(0);
    expect(audit.list(ORG).some((a) => a.action === "tool.call:brain.search" && a.decision === "allow")).toBe(true);
  });

  it("denies brain.write for a non-writer and audits the deny", async () => {
    const { gateway, audit } = setup();
    const bob = gateway.authenticate({ sub: "bob", org_id: ORG, realm_access: { roles: ["member"] } });
    const res = await gateway.callTool(bob, "brain.write", { type: "decision", title: "x", content: "y" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden");
    expect(audit.list(ORG).some((a) => a.action === "tool.call:brain.write" && a.decision === "deny")).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const { gateway } = setup();
    const bob = gateway.authenticate({ sub: "bob", org_id: ORG, realm_access: { roles: ["member"] } });
    expect((await gateway.callTool(bob, "nope")).error).toContain("unknown_tool");
  });
});
