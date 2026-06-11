/**
 * T5.1 — real MCP server over Streamable HTTP, end to end through the SDK.
 *
 * Builds a Fastify app with `mountMcp` over an in-memory CorePlatform (mirroring
 * platform.test.ts), boots it on an ephemeral port, and drives it with the real
 * `@modelcontextprotocol/sdk` client over Streamable HTTP. Identity crosses the
 * trust boundary as the dev header (`x-dev-principal`) — exactly the seam a real
 * OIDC bearer would use in prod.
 *
 * Asserts:
 *  - an authorized principal lists tools and successfully calls brain.search;
 *  - a forbidden tool call comes back isError (governance denial, in-protocol);
 *  - the per-principal rate limit rejects a flood with an MCP error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../config.js";
import { createAuthz, createStores } from "../stores.js";
import { CorePlatform } from "../platform.js";
import { mountMcp } from "./server.js";

/** OIDC-ish claims for the dev authenticator's x-dev-principal header. */
function devHeader(claims: Record<string, unknown>): Record<string, string> {
  return { "x-dev-principal": JSON.stringify(claims) };
}

const AUTHORIZED = devHeader({ sub: "alice", org_id: "acme", realm_access: { roles: ["admin"] }, groups: ["leadership"] });
const OUTSIDER = devHeader({ sub: "mallory", org_id: "acme", realm_access: { roles: [] } });

async function connectClient(url: string, headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("mcp: real Streamable HTTP server over the gateway", () => {
  let app: FastifyInstance;
  let platform: CorePlatform;
  let baseUrl: string;

  beforeAll(async () => {
    const config = loadConfig({ PERSISTENCE: "memory", AUTHZ_BACKEND: "memory", AUTH_DEV: "1", DEFAULT_ORG: "acme" } as NodeJS.ProcessEnv);
    const authz = createAuthz(config);
    const { audit, memoryStore } = await createStores(config);
    platform = new CorePlatform({ config, authz, audit, memoryStore });
    platform.seedDemo();

    app = Fastify({ logger: false });
    // Small capacity so the rate-limit test is deterministic and fast.
    await mountMcp(app, platform, { rateLimit: { capacity: 3, refillPerSec: 0 } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists the principal-filtered tool catalog for an authorized principal", async () => {
    const client = await connectClient(baseUrl, AUTHORIZED);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain("brain.search");
      expect(names).toContain("workflow.trigger");
      // input schemas are advertised so clients can build calls
      const search = tools.find((t) => t.name === "brain.search");
      expect(search?.inputSchema?.required).toContain("query");
    } finally {
      await client.close();
    }
  });

  it("calls brain.search successfully through the governed gateway path", async () => {
    const client = await connectClient(baseUrl, AUTHORIZED);
    try {
      const res = await client.callTool({ name: "brain.search", arguments: { query: "SSO", topK: 3 } });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]?.type).toBe("text");
      const hits = JSON.parse(content[0]!.text);
      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("returns an empty catalog and denies a forbidden call for an outsider", async () => {
    const client = await connectClient(baseUrl, OUTSIDER);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(0);

      // Even calling directly (a malicious client ignoring the catalog) is denied
      // by the gateway's governance.authorize — surfaced as an MCP tool error.
      const res = await client.callTool({ name: "brain.search", arguments: { query: "SSO" } });
      expect(res.isError).toBe(true);
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("forbidden");
    } finally {
      await client.close();
    }
  });

  it("enforces a per-principal rate limit (FR-7.4)", async () => {
    const client = await connectClient(baseUrl, AUTHORIZED);
    try {
      // capacity:3, refill:0 → the 4th call within the window is rate-limited.
      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push(await client.callTool({ name: "brain.search", arguments: { query: "SSO" } }));
      }
      const limited = results.filter((r) => r.isError && (r.content as Array<{ text: string }>)[0]!.text.includes("rate_limited"));
      expect(limited.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
    }
  });
});
