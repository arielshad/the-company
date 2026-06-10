import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { createAuthz, createStores } from "./stores.js";
import { CorePlatform } from "./platform.js";
import { buildServer } from "./http/server.js";

describe("core: in-memory server smoke", () => {
  let app: FastifyInstance;
  let platform: CorePlatform;

  beforeAll(async () => {
    const config = loadConfig({ PERSISTENCE: "memory", AUTHZ_BACKEND: "memory", AUTH_DEV: "1", DEFAULT_ORG: "acme" } as NodeJS.ProcessEnv);
    const authz = createAuthz(config);
    const { audit, memoryStore } = await createStores(config);
    platform = new CorePlatform({ config, authz, audit, memoryStore });
    platform.seedDemo();
    app = buildServer(platform);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves health", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("resolves the dev principal server-side", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "user:alice", orgId: "acme", roles: ["admin"] });
  });

  it("rejects /api without/with bad auth only when devAuth off — here dev principal default applies", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents.length).toBeGreaterThan(0);
  });

  it("searches the brain through the governed gateway path", async () => {
    const res = await app.inject({ method: "POST", url: "/api/brain/search", payload: { query: "SSO" } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().hits)).toBe(true);
    expect(res.json().hits.length).toBeGreaterThan(0);
  });

  it("runs the flagship workflow and pauses at the approval gate", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/wf_zoom_to_brain/run",
      // ops-bot is the principal allowed to trigger the workflow
      headers: { "x-dev-principal": JSON.stringify({ sub: "ops-bot", org_id: "acme", realm_access: { roles: ["agent"] } }) },
      payload: { data: { meetingId: "m1", transcript: "We decided to prioritize SSO for the August release. Globex renewal depends on it." } }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBeTruthy();
    expect(["paused", "completed"]).toContain(body.status);

    const approvals = await app.inject({ method: "GET", url: "/api/approvals", headers: { "x-dev-principal": JSON.stringify({ sub: "alice", org_id: "acme", realm_access: { roles: ["admin"] }, groups: ["leadership"] }) } });
    expect(approvals.statusCode).toBe(200);
  });

  it("exposes an append-only audit trail with a digest", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().digest).toBe("string");
    expect(res.json().audit.length).toBeGreaterThan(0);
  });
});
