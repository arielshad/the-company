/**
 * MCP server transport (T5.1) — STUB. Wraps the existing McpGateway in a real
 * `@modelcontextprotocol/sdk` server over Streamable HTTP, with the external
 * OIDC-client trust boundary (OIDC client-credentials → Principal → the
 * gateway's per-call authz + audit + policy-filtered catalog) and rate limits.
 *
 * Until that lands, this mounts a minimal JSON bridge so the API runs and the
 * shape is exercised. Replace the body with the real SDK transport.
 */
import type { FastifyInstance } from "fastify";
import type { CorePlatform } from "../platform.js";
import { createAuthenticator } from "../auth/session.js";

export async function mountMcp(app: FastifyInstance, platform: CorePlatform): Promise<void> {
  const authenticator = createAuthenticator(platform.config);

  // Minimal placeholder transport: list/call tools over JSON, governed by the
  // same gateway path as internal callers. The real Streamable-HTTP MCP server
  // (T5.1) replaces this.
  app.post("/mcp/tools/list", async (req) => {
    const principal = await authenticator.authenticate(req.headers as Record<string, string | string[] | undefined>);
    return { tools: await platform.gateway.listTools(principal) };
  });

  app.post("/mcp/tools/call", async (req) => {
    const principal = await authenticator.authenticate(req.headers as Record<string, string | string[] | undefined>);
    const { name, arguments: args } = (req.body ?? {}) as { name: string; arguments?: Record<string, unknown> };
    return platform.gateway.callTool(principal, name, args ?? {});
  });
}
