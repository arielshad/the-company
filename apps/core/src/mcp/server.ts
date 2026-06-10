/**
 * MCP server transport (T5.1, W5). Wraps the existing policy-enforcing
 * `McpGateway` (apps/gateway, ADR-0006) in a REAL `@modelcontextprotocol/sdk`
 * server over the **Streamable HTTP** transport, mounted on the Fastify app at
 * `/mcp`.
 *
 * Trust boundary (the whole point): the gateway's `listTools`/`callTool` already
 * do the right thing per call (policy-filtered catalog + `governance.authorize`
 * + audit + handler). This module adds (a) the network transport and (b) the
 * EXTERNAL authentication — turning an inbound OIDC bearer / client-credentials
 * token (or the dev header) into a `Principal` via the shared
 * `createAuthenticator`. No principal is ever trusted from the wire; we resolve
 * it server-side, per request, BEFORE handing anything to the gateway.
 *
 * Design notes:
 * - **Stateless per request.** Streamable HTTP is run in stateless mode
 *   (`sessionIdGenerator: undefined`): each POST gets a fresh `Server` +
 *   `StreamableHTTPServerTransport` that closes over the just-authenticated
 *   principal. This is the SDK's documented stateless pattern and means the
 *   per-request handlers never have to thread identity through transport state.
 * - **Fastify ↔ Node bridge.** Fastify owns the HTTP server, so we hand the
 *   transport the raw Node objects (`req.raw`, `reply.raw`) plus the
 *   already-parsed body, and `reply.hijack()` so Fastify doesn't also try to
 *   respond. The SDK's Node transport reconstructs a Web `Request` from the raw
 *   request; passing the parsed body avoids re-reading the consumed stream.
 * - **Rate limit (FR-7.4).** A small in-memory token bucket keyed by
 *   `principal.id` rejects floods with an MCP error before any tool runs.
 * - **No internal leakage.** Auth failures map to JSON-RPC errors; unexpected
 *   errors are logged and returned as a generic JSON-RPC internal error.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { Principal } from "@companyos/auth";
import type { CorePlatform } from "../platform.js";
import { createAuthenticator, UnauthorizedError } from "../auth/session.js";
import { TokenBucketLimiter, type RateLimitConfig } from "./rate-limit.js";
import { inputSchemaFor } from "./tool-schemas.js";

/** Options for the MCP mount (mostly for tests to tune the rate limit). */
export interface MountMcpOptions {
  rateLimit?: Partial<RateLimitConfig>;
}

const SERVER_INFO = { name: "companyos-core", version: "0.1.0" } as const;

export async function mountMcp(
  app: FastifyInstance,
  platform: CorePlatform,
  options: MountMcpOptions = {}
): Promise<void> {
  const authenticator = createAuthenticator(platform.config);
  const limiter = new TokenBucketLimiter(options.rateLimit);

  /**
   * Build a fresh, per-request MCP Server whose handlers close over the
   * authenticated principal. Because we run stateless, this is cheap and avoids
   * any cross-request identity bleed.
   */
  function buildServer(principal: Principal): Server {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await platform.gateway.listTools(principal);
      return {
        tools: tools.map<Tool>((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: inputSchemaFor(t.name)
        }))
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      // Per-principal rate limit (FR-7.4). Reject before the tool runs.
      if (!limiter.tryConsume(principal.id)) {
        return errorResult(`rate_limited: too many tool calls for ${principal.id}`);
      }

      const res = await platform.gateway.callTool(principal, name, args ?? {});
      if (!res.ok) {
        // Governance denial / unknown tool / handler error — surfaced to the
        // client as a tool error (isError), not a transport/protocol failure.
        return errorResult(res.error ?? "tool_call_failed");
      }
      return {
        content: [{ type: "text", text: jsonText(res.result) }]
      };
    });

    return server;
  }

  // Streamable HTTP: clients POST JSON-RPC and may open a GET SSE stream.
  app.post("/mcp", (req, reply) => handleMcp(req, reply));
  app.get("/mcp", (req, reply) => handleMcp(req, reply));
  app.delete("/mcp", (req, reply) => handleMcp(req, reply));

  async function handleMcp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Fastify must not also send the response: the transport writes to the raw
    // socket itself.
    reply.hijack();

    let principal: Principal;
    try {
      principal = await authenticator.authenticate(
        req.headers as Record<string, string | string[] | undefined>
      );
    } catch (err) {
      const status = err instanceof UnauthorizedError ? 401 : 500;
      writeJsonRpcError(
        reply,
        status,
        status === 401 ? ErrorCode.InvalidRequest : ErrorCode.InternalError,
        status === 401 ? "unauthorized" : "authentication_error"
      );
      return;
    }

    // Stateless: a fresh transport + server per request, scoped to this principal.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(principal);

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      // Never leak internals: log server-side, return a generic JSON-RPC error.
      app.log.error({ err }, "mcp request handling failed");
      if (!reply.raw.headersSent) {
        writeJsonRpcError(reply, 500, ErrorCode.InternalError, "internal_error");
      } else {
        reply.raw.end();
      }
    } finally {
      // The transport is single-use in stateless mode; close it (and the server)
      // once the response is flushed so streams/listeners are released.
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  }
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: "unserializable_result" });
  }
}

/** An MCP CallToolResult flagged as an error (kept inside the protocol). */
function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Write a JSON-RPC error envelope directly to the raw response — used only for
 * pre-protocol failures (auth, unexpected throws) where no MCP transport
 * response was produced. id:null per JSON-RPC for errors without a request id.
 */
function writeJsonRpcError(reply: FastifyReply, httpStatus: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  reply.raw.writeHead(httpStatus, { "content-type": "application/json" });
  reply.raw.end(body);
}
