/**
 * HTTP/JSON API (T0.2/T0.3) — a typed endpoint per former `platform.ts` method.
 * Every handler resolves the Principal server-side (T2.1) and drives CorePlatform;
 * the browser holds no authorization state. brain/workflow calls route through
 * the MCP gateway so API and MCP share one authz + audit path.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import type { CorePlatform } from "../platform.js";
import { createAuthenticator, UnauthorizedError, type Authenticator } from "../auth/session.js";
import type { Principal } from "@companyos/auth";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function principal(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError("unauthenticated");
  return req.principal;
}

export function buildServer(platform: CorePlatform, authenticator: Authenticator = createAuthenticator(platform.config)): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.register(cors, { origin: true, credentials: true });

  // Health (unauthenticated).
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ok" }));

  // Authenticate everything under /api.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    try {
      req.principal = await authenticator.authenticate(req.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      const status = err instanceof UnauthorizedError ? 401 : 500;
      reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const status = (err as { status?: number }).status ?? 500;
    reply.code(status).send({ error: (err as Error).message });
  });

  /* ---- session ---- */
  app.get("/api/me", async (req) => {
    const p = principal(req);
    return { id: p.id, type: p.type, orgId: p.orgId, roles: p.roles, groups: p.groups };
  });

  /* ---- brain ---- */
  app.post("/api/brain/search", async (req) => {
    const p = principal(req);
    const { query, topK } = z.object({ query: z.string().min(1), topK: z.number().int().positive().optional() }).parse(req.body);
    const res = await platform.gateway.callTool(p, "brain.search", { query, topK });
    if (!res.ok) throw Object.assign(new Error(res.error ?? "search failed"), { status: 403 });
    return { hits: res.result };
  });

  /* ---- connectors ---- */
  app.get("/api/connectors", async (req) => {
    principal(req);
    return { connectors: platform.listConnectors() };
  });

  /* ---- agents ---- */
  app.get("/api/agents", async (req) => {
    const p = principal(req);
    return { agents: platform.listAgents(p.orgId) };
  });
  app.get("/api/agents/org-chart", async (req) => {
    const p = principal(req);
    return { orgChart: platform.orgChart(p.orgId) };
  });
  app.post("/api/agents", async (req, reply) => {
    const p = principal(req);
    const body = z
      .object({ name: z.string().min(1), role: z.string().optional(), goal: z.string().optional(), managerAgentId: z.string().optional() })
      .parse(req.body);
    const agent = platform.agents.create({ orgId: p.orgId, ...body } as any);
    reply.code(201);
    return { agent };
  });

  /* ---- skills ---- */
  app.get("/api/skills", async (req) => {
    const p = principal(req);
    const role = (req.query as { role?: string }).role;
    return { skills: platform.listSkills(p.orgId, role) };
  });

  /* ---- workflows / builder / runs ---- */
  app.get("/api/workflows", async (req) => {
    const p = principal(req);
    return { workflows: platform.listWorkflows(p.orgId) };
  });
  app.get("/api/workflows/:id", async (req) => {
    principal(req);
    const wf = platform.getWorkflow((req.params as { id: string }).id);
    if (!wf) throw Object.assign(new Error("not found"), { status: 404 });
    return { workflow: wf };
  });
  app.post("/api/workflows", async (req, reply) => {
    const p = principal(req);
    const body = z.object({ workflow: z.any() }).parse(req.body);
    const wf = platform.publishWorkflow({ ...body.workflow, orgId: p.orgId });
    reply.code(201);
    return { workflow: wf };
  });
  app.post("/api/builder/compile", async (req) => {
    const p = principal(req);
    const body = z.object({ canvas: z.any(), meta: z.object({ id: z.string(), name: z.string() }) }).parse(req.body);
    const dsl = platform.compile(body.canvas, { id: body.meta.id, orgId: p.orgId, name: body.meta.name });
    return { dsl };
  });
  app.post("/api/workflows/:id/run", async (req) => {
    const p = principal(req);
    const id = (req.params as { id: string }).id;
    const data = (req.body as { data?: Record<string, unknown> })?.data;
    const res = await platform.gateway.callTool(p, "workflow.trigger", { workflowId: id, data });
    if (!res.ok) throw Object.assign(new Error(res.error ?? "run failed"), { status: 403 });
    return res.result;
  });
  app.get("/api/runs/:id", async (req) => {
    principal(req);
    const run = platform.getRun((req.params as { id: string }).id);
    if (!run) throw Object.assign(new Error("not found"), { status: 404 });
    return { run };
  });

  /* ---- governance ---- */
  app.get("/api/approvals", async (req) => {
    const p = principal(req);
    return { approvals: platform.listPendingApprovals(p.orgId) };
  });
  app.post("/api/approvals/:id/decide", async (req) => {
    const p = principal(req);
    const id = (req.params as { id: string }).id;
    const body = z.object({ decision: z.enum(["approved", "rejected"]), rationale: z.string().optional() }).parse(req.body);
    const approval = await platform.decideApproval(id, p, body.decision, body.rationale);
    return { approval };
  });
  app.get("/api/audit", async (req) => {
    const p = principal(req);
    return { audit: platform.auditLog(p.orgId), digest: platform.auditDigest(p.orgId) };
  });
  app.get("/api/budgets", async (req) => {
    const p = principal(req);
    const agents = platform.listAgents(p.orgId);
    return { budgets: agents.map((a) => ({ agentId: a.id, name: a.name, spentUsd: platform.budgetSpent(a.id), cap: a.budgetMonthlyUsd })) };
  });

  return app;
}
