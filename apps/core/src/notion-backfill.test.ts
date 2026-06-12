import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "./config.js";
import { createAuthz, createStores } from "./stores.js";
import { CorePlatform } from "./platform.js";
import { CONNECTORS } from "./connectors.js";

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

/** Default fetch for the auto-backfill that now fires on connect: empty result set. */
const emptyFetch = (() => Promise.resolve(searchResponse([]))) as unknown as typeof fetch;

async function makePlatform(fetchFn: typeof fetch = emptyFetch) {
  const config = loadConfig(NOTION_ENV);
  const platform = new CorePlatform({ config, authz: createAuthz(config), ...(await createStores(config)), fetchFn });
  const { user } = platform.seedDemo();
  return { platform, user };
}

describe("Notion source connector: backfill → brain ingest", () => {
  let platform: CorePlatform;
  let user: Awaited<ReturnType<typeof makePlatform>>["user"];
  beforeEach(async () => {
    ({ platform, user } = await makePlatform());
  });

  it("shows Notion configured (OAuth creds present) but not yet connected without a token", () => {
    const notion = platform.listConnectors("acme").find((c) => c.name === "notion");
    expect(notion?.configured).toBe(true);
    expect(notion?.connected).toBe(false); // no token connected yet
    expect(notion?.demo).toBe(true);
  });

  it("connecting a token flips the connector to connected and auto-starts a backfill", async () => {
    platform.connectConnectorToken("notion", "acme", "tok-xyz");
    const notion = platform.listConnectors("acme").find((c) => c.name === "notion");
    expect(notion?.connected).toBe(true);
    expect(notion?.demo).toBe(false);
    // Auto-backfill on connect: a sync is already running synchronously after connect.
    expect(notion?.sync?.status).toBe("syncing");
    await platform.triggerSync("notion", "acme"); // join the in-flight sync
    expect(platform.listConnectors("acme").find((c) => c.name === "notion")?.sync?.status).toBe("synced");
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

describe("auto-backfill on connect + truthful sync states (connect → importing → results)", () => {
  it("auto-backfills pages into the brain as soon as a token is connected", async () => {
    const fetchFn = vi.fn().mockResolvedValue(searchResponse([page("p1", "SSO rollout plan")]));
    const { platform, user } = await makePlatform(fetchFn as unknown as typeof fetch);
    platform.connectConnectorToken("notion", "acme", "tok-1");
    await platform.triggerSync("notion", "acme"); // join the auto-started sync
    const notion = platform.listConnectors("acme").find((c) => c.name === "notion");
    expect(notion?.sync?.status).toBe("synced");
    expect(notion?.sync?.ingested).toBe(1);
    expect(notion?.lastSyncAt).toBeTruthy();
    // The page is in the brain without any manual "Backfill" click.
    const hits = await platform.search(user, "SSO rollout");
    expect(hits.some((h) => h.title === "SSO rollout plan")).toBe(true);
  });

  it("surfaces an error state when the sync fails — no fictional green dot", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("notion 401"));
    const { platform } = await makePlatform(fetchFn as unknown as typeof fetch);
    platform.connectConnectorToken("notion", "acme", "bad");
    await platform.triggerSync("notion", "acme");
    const notion = platform.listConnectors("acme").find((c) => c.name === "notion");
    expect(notion?.sync?.status).toBe("error");
    expect(notion?.sync?.error).toMatch(/notion 401/);
    // The manual "Backfill"/"Retry" path re-runs and re-throws so the UI can show it.
    await expect(platform.backfillConnector("notion", "acme")).rejects.toThrow(/notion 401/);
  });

  it("disconnect clears the sync state", async () => {
    const { platform } = await makePlatform();
    platform.connectConnectorToken("notion", "acme", "tok");
    await platform.triggerSync("notion", "acme");
    platform.disconnectConnector("notion", "acme");
    const notion = platform.listConnectors("acme").find((c) => c.name === "notion");
    expect(notion?.connected).toBe(false);
    expect(notion?.sync).toBeUndefined();
  });

  it("concurrent triggers coalesce onto a single in-flight sync", async () => {
    const fetchFn = vi.fn().mockResolvedValue(searchResponse([page("p1", "SSO rollout plan")]));
    const { platform } = await makePlatform(fetchFn as unknown as typeof fetch);
    platform.connectConnectorToken("notion", "acme", "tok"); // auto-sync #1
    await Promise.all([platform.triggerSync("notion", "acme"), platform.triggerSync("notion", "acme")]);
    // One connect + two joins = exactly one network round, not three.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("connector registry: one table drives every source (no per-connector wiring)", () => {
  const sourceNames = CONNECTORS.filter((d) => d.kind === "source").map((d) => d.name);

  it("registers every catalog entry and gives every source a create factory", async () => {
    const { platform } = await makePlatform();
    const listed = platform.listConnectors("acme").map((c) => c.name);
    for (const def of CONNECTORS) {
      expect(listed).toContain(def.name); // catalog ⇒ surfaced
      // a `create` factory exists iff it's a source connector
      expect(Boolean(def.create)).toBe(def.kind === "source");
    }
  });

  // Auto-backfill on connect + tracked sync state must work for ALL sources via
  // the same code path — not just Notion. A benign empty-result fetch keeps this
  // off the network; we assert the generic lifecycle, not connector-specific parsing.
  it.each(sourceNames)("connecting %s auto-starts a tracked sync that reaches a terminal state", async (name) => {
    const fetchFn = (() => Promise.resolve(searchResponse([]))) as unknown as typeof fetch;
    const { platform } = await makePlatform(fetchFn);
    platform.connectConnectorToken(name, "acme", "tok");
    // The sync is kicked off synchronously by connect for every source.
    expect(platform.listConnectors("acme").find((c) => c.name === name)?.sync?.status).toBe("syncing");
    await platform.triggerSync(name, "acme");
    const status = platform.listConnectors("acme").find((c) => c.name === name)?.sync?.status;
    expect(["synced", "error"]).toContain(status); // terminal, never stuck "syncing"
  });
});

describe("Notion not configured: shown as demo, not connected", () => {
  it("is demo when no Notion creds are set", async () => {
    const config = loadConfig({ PERSISTENCE: "memory", AUTHZ_BACKEND: "memory", AUTH_DEV: "1", DEFAULT_ORG: "acme" } as NodeJS.ProcessEnv);
    const platform = new CorePlatform({ config, authz: createAuthz(config), ...(await createStores(config)) });
    platform.seedDemo();
    const list = platform.listConnectors("acme");
    const notion = list.find((c) => c.name === "notion");
    expect(notion?.configured).toBe(false);
    expect(notion?.connected).toBe(false);
    expect(notion?.demo).toBe(true);
    // pure-fiction sources are never falsely "connected"
    expect(list.find((c) => c.name === "google_drive")?.connected).toBe(false);
    expect(list.find((c) => c.name === "github")?.connected).toBe(false);
  });
});
