/**
 * NotionConnector tests (T4.2)
 *
 * All tests use fixture data; NO network calls are made.
 * The fetch function is always injected as a mock.
 */

import { describe, it, expect, vi } from "vitest";
import {
  NotionConnector,
  notionPageToIngest,
  mapNotionAcl,
  type NotionPageResult,
  type NotionNativePermissions,
  type NotionConnectorConfig,
} from "./notion.js";
import { runConformance } from "./sdk-node.js";
import { ORG } from "@companyos/testing";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const BASE_CFG: NotionConnectorConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://app.example/callback",
};

/** A page with workspace-level sharing (public within org). */
const workspaceSharedPage: NotionPageResult = {
  object: "page",
  id: "page-abc-123",
  url: "https://www.notion.so/page-abc-123",
  last_edited_time: "2026-06-01T10:00:00.000Z",
  created_time: "2026-05-01T10:00:00.000Z",
  properties: {
    title: { title: [{ plain_text: "Engineering Handbook" }] },
  },
  permissions: [{ type: "workspace", workspace: true }],
  public_url: null,
  archived: false,
};

/** A page restricted to two specific users. */
const restrictedPage: NotionPageResult = {
  object: "page",
  id: "page-restricted-456",
  url: "https://www.notion.so/page-restricted-456",
  last_edited_time: "2026-06-02T12:00:00.000Z",
  created_time: "2026-05-15T08:00:00.000Z",
  properties: {
    title: { title: [{ plain_text: "Q3 Strategy (Confidential)" }] },
  },
  permissions: [
    {
      type: "user",
      user: { object: "user", id: "notion-user-alice", type: "person" },
      role: "editor",
    },
    {
      type: "user",
      user: { object: "user", id: "notion-user-bob", type: "person" },
      role: "reader",
    },
  ],
  public_url: null,
  archived: false,
};

/** A page with a public URL (shared on the internet). */
const publicUrlPage: NotionPageResult = {
  object: "page",
  id: "page-public-789",
  url: "https://www.notion.so/page-public-789",
  last_edited_time: "2026-06-03T09:00:00.000Z",
  created_time: "2026-05-20T09:00:00.000Z",
  properties: {
    title: { title: [{ plain_text: "Public Product Roadmap" }] },
  },
  permissions: [],
  public_url: "https://notion.so/public/page-public-789",
  archived: false,
};

/** A page with no permissions (orphaned/private). */
const privatePage: NotionPageResult = {
  object: "page",
  id: "page-private-000",
  url: "https://www.notion.so/page-private-000",
  last_edited_time: "2026-06-04T09:00:00.000Z",
  created_time: "2026-05-25T09:00:00.000Z",
  properties: {
    title: { title: [{ plain_text: "Personal Notes" }] },
  },
  permissions: [],
  public_url: null,
  archived: false,
};

/** A Notion search API response with two pages. */
function makeSearchResponse(results: NotionPageResult[], hasMore = false) {
  return JSON.stringify({
    results,
    next_cursor: null,
    has_more: hasMore,
  });
}

/* ------------------------------------------------------------------ */
/* mapNotionAcl — ACL mapping unit tests                               */
/* ------------------------------------------------------------------ */

describe("mapNotionAcl", () => {
  it("workspace permission → public=true, allow=[]", () => {
    const acl = mapNotionAcl({
      permissions: [{ type: "workspace", workspace: true }],
    });
    expect(acl.public).toBe(true);
    expect(acl.allow).toEqual([]);
  });

  it("public_url=true → public=true, allow=[]", () => {
    const acl = mapNotionAcl({ permissions: [], publicUrl: true });
    expect(acl.public).toBe(true);
    expect(acl.allow).toEqual([]);
  });

  it("user permissions → allow contains user:<notionId>", () => {
    const acl = mapNotionAcl({
      permissions: [
        {
          type: "user",
          user: { object: "user", id: "user-id-1", type: "person" },
          role: "editor",
        },
        {
          type: "user",
          user: { object: "user", id: "user-id-2", type: "person" },
          role: "reader",
        },
      ],
    });
    expect(acl.public).toBeFalsy();
    expect(acl.allow).toContain("user:user-id-1");
    expect(acl.allow).toContain("user:user-id-2");
    expect(acl.allow).toHaveLength(2);
  });

  it("group permission → allow contains group:<groupId>", () => {
    const acl = mapNotionAcl({
      permissions: [
        {
          type: "group",
          group: { id: "group-eng", name: "Engineering" },
          role: "reader",
        },
      ],
    });
    expect(acl.public).toBeFalsy();
    expect(acl.allow).toContain("group:group-eng");
  });

  it("empty permissions (private/orphaned) → allow=[], public=false", () => {
    const acl = mapNotionAcl({ permissions: [] });
    expect(acl.allow).toEqual([]);
    expect(acl.public).toBeFalsy();
  });

  it("is deterministic — same input always produces same output", () => {
    const native: NotionNativePermissions = {
      permissions: [
        {
          type: "user",
          user: { object: "user", id: "u1", type: "person" },
          role: "reader",
        },
      ],
    };
    const r1 = mapNotionAcl(native);
    const r2 = mapNotionAcl(native);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("deduplicated and sorted — same user listed twice → single entry", () => {
    const acl = mapNotionAcl({
      permissions: [
        {
          type: "user",
          user: { object: "user", id: "u1", type: "person" },
          role: "editor",
        },
        {
          type: "user",
          user: { object: "user", id: "u1", type: "person" },
          role: "reader",
        },
      ],
    });
    expect(acl.allow).toEqual(["user:u1"]);
  });
});

/* ------------------------------------------------------------------ */
/* notionPageToIngest — payload mapping                                */
/* ------------------------------------------------------------------ */

describe("notionPageToIngest", () => {
  it("maps a workspace-shared page correctly", () => {
    const payload = notionPageToIngest(workspaceSharedPage, ORG);
    expect(payload.orgId).toBe(ORG);
    expect(payload.source.connector).toBe("notion");
    expect(payload.source.externalId).toBe("page-abc-123");
    expect(payload.source.url).toContain("notion.so");
    expect(payload.title).toBe("Engineering Handbook");
    expect(payload.sourceAcl?.public).toBe(true);
    expect(payload.sourceAcl?.allow).toEqual([]);
  });

  it("maps a restricted page with two users", () => {
    const payload = notionPageToIngest(restrictedPage, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toContain("user:notion-user-alice");
    expect(payload.sourceAcl?.allow).toContain("user:notion-user-bob");
    expect(payload.title).toBe("Q3 Strategy (Confidential)");
  });

  it("maps a public-url page as public", () => {
    const payload = notionPageToIngest(publicUrlPage, ORG);
    expect(payload.sourceAcl?.public).toBe(true);
  });

  it("maps a private page with no permissions", () => {
    const payload = notionPageToIngest(privatePage, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* NotionConnector.backfill — with injected mock fetch                 */
/* ------------------------------------------------------------------ */

describe("NotionConnector backfill (mock fetch, no network)", () => {
  it("yields one IngestPayload per non-archived page", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(makeSearchResponse([workspaceSharedPage, restrictedPage])),
    });

    const connector = new NotionConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results: ReturnType<typeof notionPageToIngest>[] = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.source.externalId).toBe("page-abc-123");
    expect(results[1]?.source.externalId).toBe("page-restricted-456");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("skips archived pages", async () => {
    const archivedPage: NotionPageResult = { ...restrictedPage, archived: true };
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeSearchResponse([archivedPage])),
    });

    const connector = new NotionConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }
    expect(results).toHaveLength(0);
  });

  it("paginates when has_more=true", async () => {
    const page1 = JSON.stringify({
      results: [workspaceSharedPage],
      next_cursor: "cursor-abc",
      has_more: true,
    });
    const page2 = JSON.stringify({
      results: [restrictedPage],
      next_cursor: null,
      has_more: false,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => JSON.parse(page1) })
      .mockResolvedValueOnce({ ok: true, json: async () => JSON.parse(page2) });

    const connector = new NotionConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // second call should include the cursor
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string);
    expect(secondCallBody.start_cursor).toBe("cursor-abc");
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    const connector = new NotionConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "bad-tok", fetch: mockFetch as unknown as typeof fetch };

    const gen = connector.backfill(ctx);
    await expect(gen.next()).rejects.toThrow("401");
  });
});

/* ------------------------------------------------------------------ */
/* NotionConnector.incremental — filters by last_edited_time          */
/* ------------------------------------------------------------------ */

describe("NotionConnector incremental (mock fetch)", () => {
  it("skips pages not edited after `since`", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(makeSearchResponse([workspaceSharedPage, restrictedPage])),
    });

    const connector = new NotionConnector(BASE_CFG);
    // workspaceSharedPage.last_edited_time = "2026-06-01T10:00:00.000Z"
    // restrictedPage.last_edited_time      = "2026-06-02T12:00:00.000Z"
    const since = "2026-06-01T11:00:00.000Z"; // only restrictedPage should pass

    const results = [];
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };
    for await (const item of connector.incremental(ctx, since)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.source.externalId).toBe("page-restricted-456");
  });
});

/* ------------------------------------------------------------------ */
/* OAuth helpers                                                        */
/* ------------------------------------------------------------------ */

describe("NotionConnector OAuth helpers", () => {
  it("authorizeUrl includes clientId, redirectUri, state, and response_type", () => {
    const connector = new NotionConnector(BASE_CFG);
    const url = connector.authorizeUrl("my-csrf-state");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("state=my-csrf-state");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("response_type=code");
    expect(url).toContain("api.notion.com");
  });

  it("exchangeCode calls the token endpoint with Basic auth and returns TokenRef", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "ntn_secret_token",
        token_type: "bearer",
        workspace_id: "ws-123",
      }),
    });

    const connector = new NotionConnector(BASE_CFG);
    const token = await connector.exchangeCode(
      "auth-code-xyz",
      BASE_CFG.redirectUri,
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("ntn_secret_token");
    expect(token.refreshToken).toBeUndefined();

    // Verify Basic auth header was sent (base64 of clientId:clientSecret)
    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toMatch(/^Basic /);
  });

  it("refresh throws (Notion does not support refresh)", async () => {
    const connector = new NotionConnector(BASE_CFG);
    await expect(connector.refresh("any-token")).rejects.toThrow("refresh not supported");
  });
});

/* ------------------------------------------------------------------ */
/* Conformance kit — NotionConnector                                   */
/* ------------------------------------------------------------------ */

describe("ConnectorConformance — NotionConnector", () => {
  it("passes all conformance invariants", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        JSON.parse(makeSearchResponse([workspaceSharedPage])),
    });

    const connector = new NotionConnector(BASE_CFG);

    const result = await runConformance(connector, {
      orgId: ORG,
      aclCases: [
        {
          label: "workspace-shared",
          native: {
            permissions: [{ type: "workspace", workspace: true }],
          } as NotionNativePermissions,
          expected: { allow: [], public: true },
        },
        {
          label: "restricted-to-user",
          native: {
            permissions: [
              {
                type: "user",
                user: { object: "user", id: "u1", type: "person" },
                role: "reader",
              },
            ],
          } as NotionNativePermissions,
          expected: { allow: ["user:u1"] },
        },
        {
          label: "private/orphaned",
          native: { permissions: [] } as NotionNativePermissions,
          expected: { allow: [] },
        },
      ],
      backfillCtx: {
        orgId: ORG,
        accessToken: "tok-test",
        fetch: mockFetch as unknown as typeof fetch,
      },
      backfillExpected: {
        connector: "notion",
        externalId: "page-abc-123",
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
