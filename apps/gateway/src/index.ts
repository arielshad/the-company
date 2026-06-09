import {
  principalFromClaims,
  type AuthzEngine,
  type OidcClaims,
  type Principal
} from "@companyos/auth";
import type { BrainService } from "@companyos/brain";
import type { GovernanceService } from "@companyos/governance";
import type { WorkflowEngine } from "@companyos/workflow-engine";
import type { SkillRegistry } from "@companyos/skill-registry";
import type { Workflow } from "@companyos/dsl";

/**
 * MCP Gateway (docs/04 §1, ADR-0006): the single policy-enforcing front door.
 * Authenticates clients (OIDC), filters the tool catalog per principal, checks
 * authorization on every call, and audits every invocation.
 *
 * This implements the MCP semantics (tools/list, tools/call) over a typed API;
 * a thin @modelcontextprotocol/sdk transport wraps it in production.
 */

export interface ToolDef {
  name: string;
  description: string;
  /** Silent capability check used to filter the catalog (no audit). */
  visibleTo: (p: Principal, authz: AuthzEngine) => boolean;
  /** (relation, object) authorized on call. */
  authorize: (p: Principal, args: Record<string, any>) => { relation: string; object: string };
  handler: (p: Principal, args: Record<string, any>) => unknown | Promise<unknown>;
}

export interface GatewayDeps {
  authz: AuthzEngine;
  governance: GovernanceService;
  brain: BrainService;
  engine: WorkflowEngine;
  skills: SkillRegistry;
  getWorkflow: (id: string) => Workflow | undefined;
  defaultOrg?: string;
}

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class McpGateway {
  private tools: ToolDef[];

  constructor(private deps: GatewayDeps) {
    this.tools = this.buildCatalog();
  }

  /** Resolve an authenticated principal from validated OIDC claims. */
  authenticate(claims: OidcClaims): Principal {
    return principalFromClaims(claims, this.deps.defaultOrg ?? "default");
  }

  /** tools/list — policy-filtered per principal (FR-7.3). */
  listTools(principal: Principal): Array<{ name: string; description: string }> {
    return this.tools
      .filter((t) => t.visibleTo(principal, this.deps.authz))
      .map((t) => ({ name: t.name, description: t.description }));
  }

  /** tools/call — authorize, audit, dispatch (FR-7.2/7.4). */
  async callTool(principal: Principal, name: string, args: Record<string, any> = {}): Promise<ToolCallResult> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { ok: false, error: `unknown_tool:${name}` };
    const { relation, object } = tool.authorize(principal, args);
    const allowed = this.deps.governance.authorize(principal, relation, object, `tool.call:${name}`);
    if (!allowed) return { ok: false, error: "forbidden" };
    try {
      const result = await tool.handler(principal, args);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private buildCatalog(): ToolDef[] {
    const { authz, brain, engine, skills, getWorkflow } = this.deps;
    return [
      {
        name: "brain.search",
        description: "Search the permission-aware company brain",
        visibleTo: (p) => authz.check(p.id, "reader", `brain:${p.orgId}`),
        authorize: (p) => ({ relation: "reader", object: `brain:${p.orgId}` }),
        handler: (p, args) => brain.search(p, { orgId: p.orgId, query: String(args.query ?? ""), topK: args.topK })
      },
      {
        name: "brain.write",
        description: "Write a typed memory object to the company brain",
        visibleTo: (p) => authz.check(p.id, "writer", `brain:${p.orgId}`),
        authorize: (p) => ({ relation: "writer", object: `brain:${p.orgId}` }),
        handler: (p, args) =>
          brain.writeMemory(
            p,
            {
              orgId: p.orgId,
              type: args.type ?? "decision",
              title: String(args.title ?? ""),
              content: String(args.content ?? ""),
              source: args.source ?? { connector: "mcp", externalId: "manual" },
              confidence: Number(args.confidence ?? 0.9)
            },
            args.policy ?? { allowedTypes: [], minConfidence: 0 }
          )
      },
      {
        name: "skill.run",
        description: "Run a registered company skill",
        visibleTo: (p) => authz.check(p.id, "member", `org:${p.orgId}`),
        authorize: (p, args) => ({ relation: "runner", object: `skill:${args.skillId}` }),
        handler: (p, args) => {
          const skill = skills.get(String(args.skillId));
          if (!skill) throw new Error("skill_not_found");
          if (skill.status !== "active") throw new Error("skill_not_active");
          return { skillId: skill.id, status: "invoked", name: skill.name };
        }
      },
      {
        name: "workflow.trigger",
        description: "Trigger a published workflow",
        visibleTo: (p) => authz.check(p.id, "member", `org:${p.orgId}`),
        authorize: (p, args) => ({ relation: "trigger", object: `workflow:${args.workflowId}` }),
        handler: async (p, args) => {
          const wf = getWorkflow(String(args.workflowId));
          if (!wf) throw new Error("workflow_not_found");
          const run = await engine.start(wf, p, args.data ?? {});
          return { runId: run.id, status: run.status };
        }
      }
    ];
  }
}
