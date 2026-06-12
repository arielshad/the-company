import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "./config.js";
import { createAuthz, createStores } from "./stores.js";
import { CorePlatform } from "./platform.js";

/**
 * T4.2 wiring: the Notion connector is registered on the platform when its
 * OAuth creds are configured, and `backfillSource` pulls pages → brain.ingest
 * with provenance + source ACL. Exercised with an injected fetch (no network).
 */

const NOTION_ENV = {
  PERSISTENCE: "memory",
  AUTHZ_BACKEND: "memory",
  AUTH_DEV: "1",
  DEFAULT_ORG: "acme",
  NOTION_CLIENT_ID: "cid",
  NOTION_CLIENT_SECRET: "secret",
  NOTION_REDIRECT_URI: "https://app.example/oauth/notion"
} as unknown as NodeJS.ProcessEnv;

function page(id: string, title: string) {
  return {
    object: "page",
    id,
    url: `https://notion.so/${id}`,
    archived: false,
    last_edited_time: "2026-06-01T10:00:00.000Z",
    created_time: "2026-05-01T10:00:00.000Z",
    properties: { title: { title: [{ plain_text: title }] } },
    permissions: [],
    // public so the captured source-ACL admits the demo viewer (ACL fidelity is
    // exercised in apps/connectors/src/notion.test.ts).
    public_url: `https://notion.so/public/${id}`
  };
}

function searchResponse(pages: unknown[]) {
  return {
    ok: true,
    json: async () => ({ results: pages, next_cursor: null, has_more: false })
  } as unknown as Response;
}

async function makePlatform() {
  const config = loadConfig(NOTION_ENV);
  const platform = new CorePlatform({ config, authz: createAuthz(config), ...(await createStores(config)) });
  const { user } = platform.seedDemo();
  return { platform, user };
}

describe("Notion source connector: backfill → brain ingest", () => {
  let platform: CorePlatform;
  let user: Awaited<ReturnType<typeof makePlatform>>["user"];
  beforeEach(async () => {
    ({ platform, user } = await makePlatform());
  });

  it("registers Notion when configured and shows it as connected (not demo)", () => {
    const notion = platform.connectors.find((c) => c.name === "notion");
    expect(notion?.connected).toBe(true);
    expect(notion?.demo).toBe(false);
  });

  it("backfills pages into the brain with provenance", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(searchResponse([page("p1", "SSO rollout plan"), page("p2", "Q3 roadmap")]));
    const res = await platform.backfillSource("notion", "tok-123", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(res.ingested).toBe(2);
    expect(res.deduped).toBe(0);
    expect(fetchFn).toHaveBeenCalledOnce();

    // The ingested pages are searchable and carry Notion provenance.
    const hits = await platform.search(user, "SSO rollout");
    expect(hits.some((h) => h.title === "SSO rollout plan" && h.source.connector === "notion")).toBe(true);

    // Backfill also indexes episodes into the temporal memory graph (FR-3.3).
    expect(platform.brain.graphEntities("acme").length).toBeGreaterThan(0);
  });

  it("re-running the backfill is idempotent (same page id dedupes)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(searchResponse([page("p1", "SSO rollout plan")]))
      .mockResolvedValueOnce(searchResponse([page("p1", "SSO rollout plan")]));
    const first = await platform.backfillSource("notion", "tok", { fetchFn: fetchFn as unknown as typeof fetch });
    const second = await platform.backfillSource("notion", "tok", { fetchFn: fetchFn as unknown as typeof fetch });
    expect(first.deduped).toBe(0);
    expect(second.deduped).toBe(1);
  });

  it("throws for an unregistered source connector", async () => {
    await expect(platform.backfillSource("dropbox", "tok")).rejects.toThrow(/not registered/);
  });
});

describe("Notion not configured: shown as demo, not connected", () => {
  it("is demo when no Notion creds are set", async () => {
    const config = loadConfig({ PERSISTENCE: "memory", AUTHZ_BACKEND: "memory", AUTH_DEV: "1", DEFAULT_ORG: "acme" } as NodeJS.ProcessEnv);
    const platform = new CorePlatform({ config, authz: createAuthz(config), ...(await createStores(config)) });
    platform.seedDemo();
    const notion = platform.connectors.find((c) => c.name === "notion");
    expect(notion?.connected).toBe(false);
    expect(notion?.demo).toBe(true);
    // pure-fiction sources (no connector code) are never falsely "connected"
    expect(platform.connectors.find((c) => c.name === "google_drive")?.connected).toBe(false);
    expect(platform.connectors.find((c) => c.name === "github")?.connected).toBe(false);
  });
});
