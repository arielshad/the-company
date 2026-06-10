import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { createAuthz, createStores } from "./stores.js";
import { CorePlatform } from "./platform.js";
import { buildServer } from "./http/server.js";

const RICH = "We decided to prioritize SSO for the August release. SSO slipping past August may delay Globex expansion. Globex expansion budget approved at 250 seats.";

describe("core: inbound connector webhook → ingest → trigger flagship", () => {
  let app: FastifyInstance;
  let platform: CorePlatform;

  beforeAll(async () => {
    const config = loadConfig({ PERSISTENCE: "memory", AUTHZ_BACKEND: "memory", AUTH_DEV: "1", DEFAULT_ORG: "acme" } as NodeJS.ProcessEnv);
    platform = new CorePlatform({ config, authz: createAuthz(config), ...(await createStores(config)) });
    platform.seedDemo();
    app = buildServer(platform);
    await app.ready();
  });
  afterAll(async () => app.close());

  it("ingests a Zoom transcript and starts the flagship run (paused at approval)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/connectors/zoom/webhook",
      payload: { meetingId: "zwh-1", topic: "Globex renewal", transcript: RICH }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.itemId).toBeTruthy();
    expect(body.runId).toBeTruthy();
    expect(body.status).toBe("paused");

    // The transcript is now in the brain and an approval is pending.
    const approvals = platform.listPendingApprovals("acme");
    expect(approvals.length).toBeGreaterThan(0);
  });

  it("a duplicate webhook is idempotent (same external id dedupes the ingest)", async () => {
    const first = await app.inject({ method: "POST", url: "/api/connectors/zoom/webhook", payload: { meetingId: "zwh-dup", topic: "t", transcript: RICH } });
    const second = await app.inject({ method: "POST", url: "/api/connectors/zoom/webhook", payload: { meetingId: "zwh-dup", topic: "t", transcript: RICH } });
    expect(first.json().deduped).toBe(false);
    expect(second.json().deduped).toBe(true);
  });
});
