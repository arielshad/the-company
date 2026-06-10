/**
 * Entrypoint: compose CorePlatform from config-selected adapters, optionally
 * seed the demo org (dev), and serve the HTTP API + MCP server. ADR-0008.
 */
import { loadConfig } from "./config.js";
import { createAuthz, createStores } from "./stores.js";
import { CorePlatform } from "./platform.js";
import { buildServer } from "./http/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const authz = createAuthz(config);
  const { audit, memoryStore } = await createStores(config);
  const platform = new CorePlatform({ config, authz, audit, memoryStore });

  // Demo seed for memory/sqlite (single-tenant MVP + e2e). Real tenant path = T2.3.
  if (config.persistence !== "postgres" && (process.env.SEED_DEMO ?? "1") !== "0") {
    platform.seedDemo();
  }

  const app = buildServer(platform);

  // Mount the MCP server (T5.1) if present. Lazy import so the API runs even
  // before the MCP transport module lands.
  try {
    const { mountMcp } = await import("./mcp/server.js");
    await mountMcp(app, platform);
    app.log.info("MCP server mounted at /mcp");
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, "MCP server not mounted");
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`core listening on ${config.host}:${config.port} (persistence=${config.persistence}, authz=${config.authzBackend})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
