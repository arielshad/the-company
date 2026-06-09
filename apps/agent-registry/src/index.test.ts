import { describe, it, expect } from "vitest";
import { AgentRegistry } from "./index.js";
import { BudgetTracker } from "@companyos/telemetry";

describe("AgentRegistry CRUD & templates", () => {
  it("creates an agent from a template", () => {
    const reg = new AgentRegistry();
    const a = reg.fromTemplate("acme", "Ada", "Engineer");
    expect(a.role).toBe("Engineer");
    expect(a.budgetMonthlyUsd).toBe(150);
    expect(reg.list("acme")).toHaveLength(1);
  });

  it("updates and archives", () => {
    const reg = new AgentRegistry();
    const a = reg.create({ orgId: "acme", name: "Bo", role: "Sales" });
    expect(reg.update(a.id, { goal: "Close deals" }).goal).toBe("Close deals");
    expect(reg.archive(a.id).status).toBe("archived");
  });
});

describe("org chart cycle prevention (FR-4.2)", () => {
  it("builds reporting tree", () => {
    const reg = new AgentRegistry();
    const ceo = reg.create({ orgId: "acme", name: "CEO", role: "CEO" });
    const pm = reg.create({ orgId: "acme", name: "PM", role: "PM", managerAgentId: ceo.id });
    const chart = reg.orgChart("acme");
    expect(chart.find((c) => c.agent.id === ceo.id)?.reports.map((r) => r.id)).toContain(pm.id);
  });

  it("rejects a manager cycle", () => {
    const reg = new AgentRegistry();
    const a = reg.create({ orgId: "acme", name: "A", role: "PM" });
    const b = reg.create({ orgId: "acme", name: "B", role: "PM", managerAgentId: a.id });
    expect(() => reg.update(a.id, { managerAgentId: b.id })).toThrow(/cycle/);
  });
});

describe("manual task run & budget (FR-4.3/4.5)", () => {
  it("runs and meters cost", async () => {
    const reg = new AgentRegistry();
    const a = reg.create({ orgId: "acme", name: "R", role: "Researcher", budgetMonthlyUsd: 100 });
    const run = await reg.runManualTask(a.id, "summarize the meeting");
    expect(run.status).toBe("completed");
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.output).toContain("handled");
  });

  it("stops a run when the budget is already exhausted", async () => {
    const budget = new BudgetTracker();
    const reg = new AgentRegistry(budget);
    const a = reg.create({ orgId: "acme", name: "R", role: "Support", budgetMonthlyUsd: 0.0001 });
    budget.record(a.id, 0.0001, 0.0001); // exhaust
    const run = await reg.runManualTask(a.id, "do work");
    expect(run.status).toBe("budget_exceeded");
  });
});
