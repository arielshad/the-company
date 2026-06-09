import { Agent, newId } from "@companyos/schemas";
import { BudgetTracker, meterCostUsd } from "@companyos/telemetry";

/**
 * Agent registry (PHASE-01): manage agents like employees — CRUD, org chart
 * with cycle prevention, budgets, agent templates, and manual task runs.
 */

export interface ModelClient {
  /** Returns the agent's output plus token usage for metering. */
  complete(req: { model: string; prompt: string }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/** Deterministic mock model client for tests/offline runs. */
export const mockModelClient: ModelClient = {
  async complete({ prompt }) {
    return { text: `handled: ${prompt.slice(0, 40)}`, inputTokens: Math.ceil(prompt.length / 4), outputTokens: 20 };
  }
};

export const AGENT_TEMPLATES: Record<string, Partial<Agent>> = {
  CEO: { role: "CEO", goal: "Set strategy and approve major decisions", model: "claude-opus-4-8", budgetMonthlyUsd: 200 },
  PM: { role: "PM", goal: "Drive product delivery", model: "claude-sonnet-4-6", budgetMonthlyUsd: 100 },
  Engineer: { role: "Engineer", goal: "Implement and review code", model: "claude-sonnet-4-6", budgetMonthlyUsd: 150 },
  Researcher: { role: "Researcher", goal: "Investigate and synthesize", model: "claude-sonnet-4-6", budgetMonthlyUsd: 80 },
  Sales: { role: "Sales", goal: "Qualify and progress deals", model: "claude-sonnet-4-6", budgetMonthlyUsd: 60 },
  Support: { role: "Support", goal: "Resolve customer issues", model: "claude-haiku-4-5", budgetMonthlyUsd: 40 }
};

export interface RunRecord {
  id: string;
  agentId: string;
  status: "completed" | "budget_exceeded";
  output?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class AgentRegistry {
  private agents = new Map<string, Agent>();

  constructor(
    private budget = new BudgetTracker(),
    private model: ModelClient = mockModelClient
  ) {}

  create(input: Partial<Agent> & Pick<Agent, "orgId" | "name">): Agent {
    const template = typeof input.role === "string" ? AGENT_TEMPLATES[input.role] : undefined;
    const agent = Agent.parse({
      ...template,
      ...input,
      id: input.id ?? newId("agent")
    });
    if (agent.managerAgentId) this.assertNoCycle(agent.id, agent.managerAgentId);
    this.agents.set(agent.id, agent);
    return agent;
  }

  fromTemplate(orgId: string, name: string, template: keyof typeof AGENT_TEMPLATES): Agent {
    return this.create({ orgId, name, ...AGENT_TEMPLATES[template] });
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(orgId: string): Agent[] {
    return [...this.agents.values()].filter((a) => a.orgId === orgId);
  }

  update(id: string, patch: Partial<Agent>): Agent {
    const cur = this.agents.get(id);
    if (!cur) throw new Error(`agent ${id} not found`);
    const next = Agent.parse({ ...cur, ...patch, id });
    if (next.managerAgentId) this.assertNoCycle(id, next.managerAgentId);
    this.agents.set(id, next);
    return next;
  }

  archive(id: string): Agent {
    return this.update(id, { status: "archived" });
  }

  /** Build the reporting tree for an org (FR-4.2). */
  orgChart(orgId: string): Array<{ agent: Agent; reports: Agent[] }> {
    const all = this.list(orgId);
    return all.map((agent) => ({
      agent,
      reports: all.filter((a) => a.managerAgentId === agent.id)
    }));
  }

  private assertNoCycle(agentId: string, managerId: string): void {
    let cursor: string | undefined = managerId;
    const seen = new Set<string>([agentId]);
    while (cursor) {
      if (seen.has(cursor)) throw new Error("manager cycle detected");
      seen.add(cursor);
      cursor = this.agents.get(cursor)?.managerAgentId;
    }
  }

  /** Run a manual task; meters cost and enforces the agent's budget (FR-4.5). */
  async runManualTask(agentId: string, task: string): Promise<RunRecord> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const model = agent.model ?? "claude-sonnet-4-6";

    // pre-check budget with a small estimate
    const estimate = meterCostUsd(model, Math.ceil(task.length / 4), 256);
    const pre = this.budget.preCheck(agentId, agent.budgetMonthlyUsd, estimate);
    if (pre.status === "exceeded") {
      return { id: newId("run"), agentId, status: "budget_exceeded", costUsd: 0, inputTokens: 0, outputTokens: 0 };
    }

    const res = await this.model.complete({ model, prompt: `${agent.goal}\n\nTask: ${task}` });
    const cost = meterCostUsd(model, res.inputTokens, res.outputTokens);
    const decision = this.budget.record(agentId, agent.budgetMonthlyUsd, cost);
    return {
      id: newId("run"),
      agentId,
      status: decision.status === "exceeded" ? "budget_exceeded" : "completed",
      output: res.text,
      costUsd: cost,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens
    };
  }
}
