/**
 * GmailConnector tests (T4.x)
 *
 * All tests use fixture data; NO network calls are made.
 * The fetch function is always injected as a mock.
 */

import { describe, it, expect, vi } from "vitest";
import {
  GmailConnector,
  gmailMessageToIngest,
  mapGmailAcl,
  type GmailMessage,
  type GmailNativePermissions,
  type GmailConnectorConfig,
} from "./gmail.js";
import { runConformance } from "./sdk-node.js";
import { ORG } from "@companyos/testing";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const BASE_CFG: GmailConnectorConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://app.example/callback",
};

const OWNER = "alice@example.com";

/** Encode a UTF-8 string as URL-safe base64 (Gmail body format). */
function b64url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Build a full Gmail message fixture. */
function makeMessage(
  id: string,
  opts: {
    subject?: string;
    from?: string;
    body?: string;
    labelIds?: string[];
    snippet?: string;
  } = {}
): GmailMessage {
  const headers = [
    ...(opts.subject !== undefined ? [{ name: "Subject", value: opts.subject }] : []),
    ...(opts.from !== undefined ? [{ name: "From", value: opts.from }] : []),
    { name: "Date", value: "Mon, 01 Jun 2026 10:00:00 +0000" },
  ];
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: opts.labelIds ?? ["INBOX", "UNREAD"],
    snippet: opts.snippet ?? "snippet text",
    internalDate: "1748772000000",
    payload: {
      mimeType: "text/plain",
      headers,
      body: { data: b64url(opts.body ?? "Hello world") },
    },
  };
}

const inboxMessage = makeMessage("msg-aaa-111", {
  subject: "Quarterly Review",
  from: "bob@example.com",
  body: "The numbers look great this quarter.",
});

const secondMessage = makeMessage("msg-bbb-222", {
  subject: "Lunch?",
  from: "carol@example.com",
  body: "Want to grab lunch tomorrow?",
});

const trashedMessage = makeMessage("msg-trash-333", {
  subject: "Old thread",
  from: "spammer@example.com",
  body: "delete me",
  labelIds: ["TRASH"],
});

const spamMessage = makeMessage("msg-spam-444", {
  subject: "You won!",
  from: "scam@example.com",
  body: "claim your prize",
  labelIds: ["SPAM"],
});

/**
 * Build a mock fetch that routes by URL:
 *  - /profile         → { emailAddress: OWNER }
 *  - /messages?...    → a messages.list page (id stubs + optional nextPageToken)
 *  - /messages/{id}   → the full message keyed by id
 *
 * `listPages` is an array of list responses returned in order (for pagination).
 */
function makeMockFetch(opts: {
  owner?: string | undefined;
  profileFails?: boolean;
  listPages: Array<{ messages?: Array<{ id: string }>; nextPageToken?: string }>;
  messages: Record<string, GmailMessage>;
}) {
  let listCall = 0;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/profile")) {
      if (opts.profileFails) return { ok: false, status: 403 };
      return {
        ok: true,
        json: async () => (opts.owner === undefined ? {} : { emailAddress: opts.owner }),
      };
    }
    // messages.get — /messages/{id}?format=full (has a path segment after messages/)
    const getMatch = url.match(/\/messages\/([^/?]+)\?/);
    if (getMatch) {
      const id = getMatch[1] as string;
      const msg = opts.messages[id];
      if (!msg) return { ok: false, status: 404 };
      return { ok: true, json: async () => msg };
    }
    // messages.list — /messages?...
    if (url.includes("/messages?")) {
      const page = opts.listPages[listCall] ?? { messages: [] };
      listCall += 1;
      return { ok: true, json: async () => page };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const ctxWith = (mockFetch: ReturnType<typeof makeMockFetch>, accessToken = "tok-test") => ({
  orgId: ORG,
  accessToken,
  fetch: mockFetch as unknown as typeof fetch,
});

/* ------------------------------------------------------------------ */
/* mapGmailAcl — ACL mapping unit tests (case table)                   */
/* ------------------------------------------------------------------ */

describe("mapGmailAcl", () => {
  const cases: Array<{
    label: string;
    native: GmailNativePermissions;
    expected: { allow: string[]; public?: boolean };
  }> = [
    {
      label: "owner email → allow user:<owner>, never public",
      native: { ownerEmail: "alice@example.com" },
      expected: { allow: ["user:alice@example.com"] },
    },
    {
      label: "owner email is lowercased + trimmed",
      native: { ownerEmail: "  Alice@Example.COM  " },
      expected: { allow: ["user:alice@example.com"] },
    },
    {
      label: "missing owner email → deny (allow=[])",
      native: {},
      expected: { allow: [] },
    },
    {
      label: "blank owner email → deny (allow=[])",
      native: { ownerEmail: "   " },
      expected: { allow: [] },
    },
    {
      label: "syntactically invalid email (no @) → deny",
      native: { ownerEmail: "not-an-email" },
      expected: { allow: [] },
    },
    {
      label: "email with spaces → deny",
      native: { ownerEmail: "a b@example.com" },
      expected: { allow: [] },
    },
    {
      label: "double-@ → deny",
      native: { ownerEmail: "a@b@example.com" },
      expected: { allow: [] },
    },
  ];

  for (const { label, native, expected } of cases) {
    it(label, () => {
      const acl = mapGmailAcl(native);
      expect(acl.allow).toEqual(expected.allow);
      // Security-critical: a mailbox is never public.
      expect(acl.public).toBeFalsy();
    });
  }

  it("is deterministic — same input always produces same output", () => {
    const native: GmailNativePermissions = { ownerEmail: OWNER };
    const r1 = mapGmailAcl(native);
    const r2 = mapGmailAcl(native);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

/* ------------------------------------------------------------------ */
/* gmailMessageToIngest — payload mapping                              */
/* ------------------------------------------------------------------ */

describe("gmailMessageToIngest", () => {
  it("maps an inbox message correctly", () => {
    const payload = gmailMessageToIngest(inboxMessage, ORG, OWNER);
    expect(payload.orgId).toBe(ORG);
    expect(payload.source.connector).toBe("gmail");
    expect(payload.source.externalId).toBe("msg-aaa-111");
    expect(payload.source.url).toBe(
      "https://mail.google.com/mail/u/0/#inbox/msg-aaa-111"
    );
    expect(payload.title).toBe("Quarterly Review");
    expect(payload.content).toContain("The numbers look great this quarter.");
    expect(payload.content).toContain("From: bob@example.com");
  });

  it("ACL is private to the owner, never public", () => {
    const payload = gmailMessageToIngest(inboxMessage, ORG, OWNER);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual(["user:alice@example.com"]);
  });

  it("missing owner email → conservative deny", () => {
    const payload = gmailMessageToIngest(inboxMessage, ORG, undefined);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([]);
  });

  it("falls back to a stable title when Subject is absent", () => {
    const noSubject = makeMessage("msg-no-subj", { from: "x@example.com", body: "hi" });
    // remove the subject header
    noSubject.payload!.headers = noSubject.payload!.headers!.filter(
      (h) => h.name !== "Subject"
    );
    const payload = gmailMessageToIngest(noSubject, ORG, OWNER);
    expect(payload.title).toBe("(no subject) msg-no-subj");
  });
});

/* ------------------------------------------------------------------ */
/* GmailConnector.backfill — with injected mock fetch                  */
/* ------------------------------------------------------------------ */

describe("GmailConnector backfill (mock fetch, no network)", () => {
  it("yields one IngestPayload per non-trashed message", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [{ messages: [{ id: "msg-aaa-111" }, { id: "msg-bbb-222" }] }],
      messages: { "msg-aaa-111": inboxMessage, "msg-bbb-222": secondMessage },
    });

    const connector = new GmailConnector(BASE_CFG);
    const results: ReturnType<typeof gmailMessageToIngest>[] = [];
    for await (const item of connector.backfill(ctxWith(mockFetch))) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.source.externalId).toBe("msg-aaa-111");
    expect(results[1]?.source.externalId).toBe("msg-bbb-222");
    // every message is private to the owner
    expect(results[0]?.sourceAcl?.allow).toEqual(["user:alice@example.com"]);
    expect(results[0]?.sourceAcl?.public).toBeFalsy();
  });

  it("skips trashed and spam messages", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [
        {
          messages: [
            { id: "msg-aaa-111" },
            { id: "msg-trash-333" },
            { id: "msg-spam-444" },
          ],
        },
      ],
      messages: {
        "msg-aaa-111": inboxMessage,
        "msg-trash-333": trashedMessage,
        "msg-spam-444": spamMessage,
      },
    });

    const connector = new GmailConnector(BASE_CFG);
    const results = [];
    for await (const item of connector.backfill(ctxWith(mockFetch))) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.source.externalId).toBe("msg-aaa-111");
  });

  it("paginates when nextPageToken is present", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [
        { messages: [{ id: "msg-aaa-111" }], nextPageToken: "page-2-token" },
        { messages: [{ id: "msg-bbb-222" }] },
      ],
      messages: { "msg-aaa-111": inboxMessage, "msg-bbb-222": secondMessage },
    });

    const connector = new GmailConnector(BASE_CFG);
    const results = [];
    for await (const item of connector.backfill(ctxWith(mockFetch))) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    // Find the two list calls and assert the second carried the page token.
    const listCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("/messages?")
    );
    expect(listCalls).toHaveLength(2);
    expect(String(listCalls[1]?.[0])).toContain("pageToken=page-2-token");
  });

  it("never logs tokens — Authorization header carries the bearer token", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [{ messages: [{ id: "msg-aaa-111" }] }],
      messages: { "msg-aaa-111": inboxMessage },
    });
    const connector = new GmailConnector(BASE_CFG);
    for await (const _ of connector.backfill(ctxWith(mockFetch, "secret-tok"))) {
      // drain
    }
    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe("Bearer secret-tok");
  });

  it("throws on messages.list HTTP error", async () => {
    const mockFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/profile")) {
        return { ok: true, json: async () => ({ emailAddress: OWNER }) };
      }
      return { ok: false, status: 401 };
    });
    const connector = new GmailConnector(BASE_CFG);
    const gen = connector.backfill(ctxWith(mockFetch as unknown as ReturnType<typeof makeMockFetch>, "bad-tok"));
    await expect(gen.next()).rejects.toThrow("401");
  });
});

/* ------------------------------------------------------------------ */
/* GmailConnector.incremental — q=after:<unix-seconds>                 */
/* ------------------------------------------------------------------ */

describe("GmailConnector incremental (mock fetch)", () => {
  it("passes an `after:` query derived from `since`", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [{ messages: [{ id: "msg-aaa-111" }] }],
      messages: { "msg-aaa-111": inboxMessage },
    });

    const connector = new GmailConnector(BASE_CFG);
    const since = "2026-06-01T00:00:00.000Z";
    const expectedSeconds = Math.floor(new Date(since).getTime() / 1000);

    const results = [];
    for await (const item of connector.incremental(ctxWith(mockFetch), since)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    const listCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/messages?")
    );
    const url = String(listCall?.[0]);
    // q is URL-encoded as after%3A<seconds>
    expect(decodeURIComponent(url)).toContain(`after:${expectedSeconds}`);
  });

  it("backfill does NOT include an `after:` query", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [{ messages: [{ id: "msg-aaa-111" }] }],
      messages: { "msg-aaa-111": inboxMessage },
    });

    const connector = new GmailConnector(BASE_CFG);
    for await (const _ of connector.backfill(ctxWith(mockFetch))) {
      // drain
    }
    const listCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("/messages?")
    );
    expect(String(listCall?.[0])).not.toContain("q=");
  });
});

/* ------------------------------------------------------------------ */
/* OAuth helpers                                                        */
/* ------------------------------------------------------------------ */

describe("GmailConnector OAuth helpers", () => {
  it("authorizeUrl includes clientId, redirectUri, state, scope, offline access", () => {
    const connector = new GmailConnector(BASE_CFG);
    const url = connector.authorizeUrl("my-csrf-state");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("state=my-csrf-state");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("response_type=code");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain("access_type=offline");
    expect(decodeURIComponent(url)).toContain(
      "https://www.googleapis.com/auth/gmail.readonly"
    );
  });

  it("exchangeCode posts form-encoded body and returns a TokenRef", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "ya29.secret_access",
        refresh_token: "1//refresh_secret",
        expires_in: 3599,
        scope: GMAIL_SCOPE_FIXTURE,
        token_type: "Bearer",
      }),
    });

    const connector = new GmailConnector(BASE_CFG);
    const token = await connector.exchangeCode(
      "auth-code-xyz",
      BASE_CFG.redirectUri,
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("ya29.secret_access");
    expect(token.refreshToken).toBe("1//refresh_secret");
    expect(typeof token.expiresAt).toBe("number");

    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(call?.[1]?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
  });

  it("refresh preserves the original refresh token when Google omits a new one", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "ya29.new_access", expires_in: 3599 }),
    });

    const connector = new GmailConnector(BASE_CFG);
    const token = await connector.refresh(
      "1//original_refresh",
      mockFetch as unknown as typeof fetch
    );
    expect(token.accessToken).toBe("ya29.new_access");
    expect(token.refreshToken).toBe("1//original_refresh");
  });

  it("exchangeCode throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 400 });
    const connector = new GmailConnector(BASE_CFG);
    await expect(
      connector.exchangeCode("bad", BASE_CFG.redirectUri, mockFetch as unknown as typeof fetch)
    ).rejects.toThrow("400");
  });
});

const GMAIL_SCOPE_FIXTURE = "https://www.googleapis.com/auth/gmail.readonly";

/* ------------------------------------------------------------------ */
/* Conformance kit — GmailConnector                                    */
/* ------------------------------------------------------------------ */

describe("ConnectorConformance — GmailConnector", () => {
  it("passes all conformance invariants", async () => {
    const mockFetch = makeMockFetch({
      owner: OWNER,
      listPages: [{ messages: [{ id: "msg-aaa-111" }] }],
      messages: { "msg-aaa-111": inboxMessage },
    });

    const connector = new GmailConnector(BASE_CFG);

    const result = await runConformance(connector, {
      orgId: ORG,
      aclCases: [
        {
          label: "owner-private",
          native: { ownerEmail: OWNER } as GmailNativePermissions,
          expected: { allow: ["user:alice@example.com"] },
        },
        {
          label: "missing-owner-deny",
          native: {} as GmailNativePermissions,
          expected: { allow: [] },
        },
        {
          label: "invalid-owner-deny",
          native: { ownerEmail: "garbage" } as GmailNativePermissions,
          expected: { allow: [] },
        },
      ],
      backfillCtx: {
        orgId: ORG,
        accessToken: "tok-test",
        fetch: mockFetch as unknown as typeof fetch,
      },
      backfillExpected: {
        connector: "gmail",
        externalId: "msg-aaa-111",
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
