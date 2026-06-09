import { NODE_TYPES, TRIGGER_KINDS, canvasToDsl, validateWorkflow, type Canvas } from "@companyos/dsl";

/**
 * web (PHASE-03 builder UI shell). The React Flow canvas lives in the browser;
 * this module is the BFF logic it calls — the node palette and the
 * canvas→DSL compile+validate endpoint. Pure functions so they are unit-tested
 * without a browser; `serve.ts` exposes them over HTTP for the K8s Deployment.
 */

export interface PaletteEntry {
  type: string;
  category: "trigger" | "io" | "logic" | "governance" | "effect";
  description: string;
}

const CATEGORY: Record<string, PaletteEntry["category"]> = {
  trigger: "trigger",
  brain_search: "io",
  agent: "io",
  tool: "io",
  skill: "io",
  condition: "logic",
  loop: "logic",
  approval: "governance",
  eval: "governance",
  memory_write: "effect",
  task: "effect",
  notify: "effect",
  end: "logic"
};

const DESCRIPTIONS: Record<string, string> = {
  trigger: "Entry point (manual/schedule/webhook/zoom/slack/github/jira/…)",
  brain_search: "Search the permission-aware company brain",
  agent: "Role-based LLM agent with goal, tools, memory, budget",
  tool: "Call an approved MCP tool",
  skill: "Invoke a reusable company skill",
  condition: "Branch on extracted facts / confidence / status",
  loop: "Retry / iterate with bounds",
  approval: "Human-in-the-loop review",
  eval: "Quality/factuality/policy gate",
  memory_write: "Persist a typed memory object",
  task: "Create ticket / assign / follow-up",
  notify: "Slack / email / Jira / Notion update",
  end: "Return result / publish output"
};

export function builderPalette(): PaletteEntry[] {
  return NODE_TYPES.map((t) => ({ type: t, category: CATEGORY[t] ?? "io", description: DESCRIPTIONS[t] ?? t }));
}

export function triggerKinds(): readonly string[] {
  return TRIGGER_KINDS;
}

export interface CompileRequest {
  canvas: Canvas;
  meta: { id: string; orgId: string; name: string };
}

export function compileCanvas(req: CompileRequest) {
  const dsl = canvasToDsl(req.canvas, req.meta);
  const validation = validateWorkflow(dsl);
  return { dsl, validation };
}

export type RouteResult = { status: number; body: unknown };

/** Pure HTTP router (transport-agnostic, easy to unit test). */
export function route(method: string, path: string, body?: unknown): RouteResult {
  if (method === "GET" && (path === "/healthz" || path === "/readyz")) {
    return { status: 200, body: { status: "ok" } };
  }
  if (method === "GET" && path === "/api/builder/palette") {
    return { status: 200, body: { palette: builderPalette(), triggers: triggerKinds() } };
  }
  if (method === "POST" && path === "/api/builder/compile") {
    try {
      const result = compileCanvas(body as CompileRequest);
      return { status: result.validation.valid ? 200 : 422, body: result };
    } catch (e) {
      return { status: 400, body: { error: (e as Error).message } };
    }
  }
  return { status: 404, body: { error: "not_found" } };
}
