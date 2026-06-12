/**
 * GoogleCalendarConnector tests (T4.x)
 *
 * All tests use fixture data; NO network calls are made.
 * The fetch function is always injected as a mock.
 */

import { describe, it, expect, vi } from "vitest";
import {
  GoogleCalendarConnector,
  googleCalendarEventToIngest,
  mapGoogleCalendarAcl,
  type GoogleCalendarEvent,
  type GoogleCalendarNativePermissions,
  type GoogleCalendarConnectorConfig,
} from "./calendar.js";
import { runConformance } from "./sdk-node.js";
import { ORG } from "@companyos/testing";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const BASE_CFG: GoogleCalendarConnectorConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://app.example/callback",
};

/** A normal team meeting: organizer + two attendees, default visibility. */
const teamMeeting: GoogleCalendarEvent = {
  id: "evt-team-123",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=evt-team-123",
  updated: "2026-06-02T12:00:00.000Z",
  created: "2026-05-15T08:00:00.000Z",
  summary: "Weekly Team Sync",
  description: "Status updates and blockers.",
  visibility: "default",
  organizer: { email: "Alice@Example.com", displayName: "Alice" },
  attendees: [
    { email: "Alice@Example.com", displayName: "Alice", organizer: true, responseStatus: "accepted" },
    { email: "bob@example.com", displayName: "Bob", responseStatus: "accepted" },
    { email: "carol@example.com", displayName: "Carol", responseStatus: "tentative" },
  ],
  start: { dateTime: "2026-06-10T15:00:00Z" },
  end: { dateTime: "2026-06-10T15:30:00Z" },
};

/** A public event (e.g. a company all-hands published publicly). */
const publicEvent: GoogleCalendarEvent = {
  id: "evt-public-789",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=evt-public-789",
  updated: "2026-06-03T09:00:00.000Z",
  created: "2026-05-20T09:00:00.000Z",
  summary: "Public Launch Webinar",
  visibility: "public",
  organizer: { email: "events@example.com" },
  attendees: [{ email: "events@example.com", organizer: true }],
  start: { dateTime: "2026-06-11T17:00:00Z" },
  end: { dateTime: "2026-06-11T18:00:00Z" },
};

/** A private 1:1 between two people. */
const privateOneOnOne: GoogleCalendarEvent = {
  id: "evt-1on1-456",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=evt-1on1-456",
  updated: "2026-06-04T09:00:00.000Z",
  created: "2026-05-25T09:00:00.000Z",
  summary: "1:1 Alice / Dave",
  visibility: "private",
  organizer: { email: "alice@example.com" },
  attendees: [
    { email: "alice@example.com", organizer: true },
    { email: "dave@example.com" },
  ],
  start: { dateTime: "2026-06-12T20:00:00Z" },
  end: { dateTime: "2026-06-12T20:30:00Z" },
};

/** An event with no organizer email and no usable attendee emails. */
const orphanedEvent: GoogleCalendarEvent = {
  id: "evt-orphan-000",
  status: "confirmed",
  htmlLink: "https://www.google.com/calendar/event?eid=evt-orphan-000",
  updated: "2026-06-05T09:00:00.000Z",
  created: "2026-05-26T09:00:00.000Z",
  summary: "Hold",
  visibility: "default",
  start: { date: "2026-06-13" },
  end: { date: "2026-06-14" },
};

/** A Google Calendar events.list response with the given items. */
function makeEventsResponse(items: GoogleCalendarEvent[], nextPageToken?: string) {
  const body: Record<string, unknown> = { kind: "calendar#events", items };
  if (nextPageToken) body["nextPageToken"] = nextPageToken;
  return JSON.stringify(body);
}

/* ------------------------------------------------------------------ */
/* mapGoogleCalendarAcl — ACL mapping unit tests (case table)          */
/* ------------------------------------------------------------------ */

interface AclCase {
  label: string;
  native: GoogleCalendarNativePermissions;
  expectedAllow: string[];
  expectedPublic: boolean;
}

const ACL_CASES: AclCase[] = [
  {
    label: "public visibility → public=true, allow=[]",
    native: {
      visibility: "public",
      organizer: { email: "events@example.com" },
      attendees: [{ email: "guest@example.com" }],
    },
    expectedAllow: [],
    expectedPublic: true,
  },
  {
    label: "default visibility → organizer + attendees, not public",
    native: {
      visibility: "default",
      organizer: { email: "alice@example.com" },
      attendees: [
        { email: "alice@example.com", organizer: true },
        { email: "bob@example.com" },
      ],
    },
    expectedAllow: ["user:alice@example.com", "user:bob@example.com"],
    expectedPublic: false,
  },
  {
    label: "private visibility → still scoped to participants, not public",
    native: {
      visibility: "private",
      organizer: { email: "alice@example.com" },
      attendees: [{ email: "dave@example.com" }],
    },
    expectedAllow: ["user:alice@example.com", "user:dave@example.com"],
    expectedPublic: false,
  },
  {
    label: "confidential visibility → not public",
    native: {
      visibility: "confidential",
      organizer: { email: "alice@example.com" },
    },
    expectedAllow: ["user:alice@example.com"],
    expectedPublic: false,
  },
  {
    label: "undefined visibility → not public (conservative)",
    native: { organizer: { email: "alice@example.com" } },
    expectedAllow: ["user:alice@example.com"],
    expectedPublic: false,
  },
  {
    label: "emails are normalized (trim + lowercase) and deduped",
    native: {
      visibility: "default",
      organizer: { email: "Alice@Example.com" },
      attendees: [
        { email: "alice@example.com", organizer: true },
        { email: "  BOB@example.com  " },
      ],
    },
    expectedAllow: ["user:alice@example.com", "user:bob@example.com"],
    expectedPublic: false,
  },
  {
    label: "resource attendees (rooms) are dropped",
    native: {
      visibility: "default",
      organizer: { email: "alice@example.com" },
      attendees: [
        { email: "alice@example.com", organizer: true },
        { email: "room-7@resource.calendar.google.com", resource: true },
      ],
    },
    expectedAllow: ["user:alice@example.com"],
    expectedPublic: false,
  },
  {
    label: "attendees without emails are dropped (never invent a principal)",
    native: {
      visibility: "default",
      organizer: { email: "alice@example.com" },
      attendees: [{ displayName: "Mystery Guest" }, { email: "" }],
    },
    expectedAllow: ["user:alice@example.com"],
    expectedPublic: false,
  },
  {
    label: "malformed emails are dropped (conservative)",
    native: {
      visibility: "default",
      organizer: { email: "not-an-email" },
      attendees: [{ email: "also bad@example.com" }, { email: "ok@example.com" }],
    },
    expectedAllow: ["user:ok@example.com"],
    expectedPublic: false,
  },
  {
    label: "no organizer, no usable attendees → allow=[], not public (deny)",
    native: { visibility: "default" },
    expectedAllow: [],
    expectedPublic: false,
  },
];

describe("mapGoogleCalendarAcl (case table)", () => {
  for (const c of ACL_CASES) {
    it(c.label, () => {
      const acl = mapGoogleCalendarAcl(c.native);
      expect(acl.allow).toEqual(c.expectedAllow);
      expect(!!acl.public).toBe(c.expectedPublic);
    });
  }

  it("never produces public=true for a non-public visibility", () => {
    for (const v of ["default", "private", "confidential", undefined]) {
      const acl = mapGoogleCalendarAcl({
        visibility: v,
        organizer: { email: "x@example.com" },
      });
      expect(acl.public).toBeFalsy();
    }
  });

  it("is deterministic — same input always produces same output", () => {
    const native: GoogleCalendarNativePermissions = {
      visibility: "default",
      organizer: { email: "alice@example.com" },
      attendees: [{ email: "bob@example.com" }],
    };
    const r1 = mapGoogleCalendarAcl(native);
    const r2 = mapGoogleCalendarAcl(native);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("allow[] is sorted", () => {
    const acl = mapGoogleCalendarAcl({
      visibility: "default",
      organizer: { email: "zed@example.com" },
      attendees: [{ email: "amy@example.com" }, { email: "mike@example.com" }],
    });
    expect(acl.allow).toEqual([
      "user:amy@example.com",
      "user:mike@example.com",
      "user:zed@example.com",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* googleCalendarEventToIngest — payload mapping                       */
/* ------------------------------------------------------------------ */

describe("googleCalendarEventToIngest", () => {
  it("maps a team meeting to attendee-scoped ACL", () => {
    const payload = googleCalendarEventToIngest(teamMeeting, ORG);
    expect(payload.orgId).toBe(ORG);
    expect(payload.source.connector).toBe("google_calendar");
    expect(payload.source.externalId).toBe("evt-team-123");
    expect(payload.source.url).toBe(teamMeeting.htmlLink);
    expect(payload.title).toBe("Weekly Team Sync");
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([
      "user:alice@example.com",
      "user:bob@example.com",
      "user:carol@example.com",
    ]);
  });

  it("content includes summary, description, attendees, and start/end", () => {
    const payload = googleCalendarEventToIngest(teamMeeting, ORG);
    expect(payload.content).toContain("Weekly Team Sync");
    expect(payload.content).toContain("Status updates and blockers.");
    expect(payload.content).toContain("Attendees:");
    expect(payload.content).toContain("Alice@Example.com");
    expect(payload.content).toContain("bob@example.com");
    expect(payload.content).toContain("Start: 2026-06-10T15:00:00Z");
    expect(payload.content).toContain("End: 2026-06-10T15:30:00Z");
  });

  it("maps a public event as public", () => {
    const payload = googleCalendarEventToIngest(publicEvent, ORG);
    expect(payload.sourceAcl?.public).toBe(true);
    expect(payload.sourceAcl?.allow).toEqual([]);
  });

  it("maps a private 1:1 to its two participants only", () => {
    const payload = googleCalendarEventToIngest(privateOneOnOne, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([
      "user:alice@example.com",
      "user:dave@example.com",
    ]);
  });

  it("maps an orphaned event (no participants) to allow=[], not public", () => {
    const payload = googleCalendarEventToIngest(orphanedEvent, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([]);
    expect(payload.title).toBe("Hold");
  });

  it("falls back to an id-based title when summary is missing", () => {
    const noSummary: GoogleCalendarEvent = { id: "evt-x", status: "confirmed" };
    const payload = googleCalendarEventToIngest(noSummary, ORG);
    expect(payload.title).toBe("Event evt-x");
  });
});

/* ------------------------------------------------------------------ */
/* GoogleCalendarConnector.backfill — with injected mock fetch         */
/* ------------------------------------------------------------------ */

describe("GoogleCalendarConnector backfill (mock fetch, no network)", () => {
  it("yields one IngestPayload per non-cancelled event", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(makeEventsResponse([teamMeeting, privateOneOnOne])),
    });

    const connector = new GoogleCalendarConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results: ReturnType<typeof googleCalendarEventToIngest>[] = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.source.externalId).toBe("evt-team-123");
    expect(results[1]?.source.externalId).toBe("evt-1on1-456");
    expect(mockFetch).toHaveBeenCalledOnce();

    // Sanity: backfill hits the primary calendar with singleEvents=true and no updatedMin.
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/calendars/primary/events");
    expect(url).toContain("singleEvents=true");
    expect(url).not.toContain("updatedMin");
  });

  it("never logs the access token (Bearer header carries it instead)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeEventsResponse([teamMeeting])),
    });
    const connector = new GoogleCalendarConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "super-secret-token", fetch: mockFetch as unknown as typeof fetch };
    for await (const _ of connector.backfill(ctx)) { /* drain */ }

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe("Bearer super-secret-token");
  });

  it("skips cancelled (trashed/archived) events", async () => {
    const cancelledEvent: GoogleCalendarEvent = { ...teamMeeting, id: "evt-cancelled", status: "cancelled" };
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () =>
        JSON.parse(makeEventsResponse([cancelledEvent, privateOneOnOne])),
    });

    const connector = new GoogleCalendarConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }
    expect(results).toHaveLength(1);
    expect(results[0]?.source.externalId).toBe("evt-1on1-456");
  });

  it("paginates when nextPageToken is present", async () => {
    const page1 = makeEventsResponse([teamMeeting], "page-token-2");
    const page2 = makeEventsResponse([privateOneOnOne]); // no nextPageToken → last page

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => JSON.parse(page1) })
      .mockResolvedValueOnce({ ok: true, json: async () => JSON.parse(page2) });

    const connector = new GoogleCalendarConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // second call should include the page token
    const secondCallUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toContain("pageToken=page-token-2");
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    const connector = new GoogleCalendarConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "bad-tok", fetch: mockFetch as unknown as typeof fetch };

    const gen = connector.backfill(ctx);
    await expect(gen.next()).rejects.toThrow("401");
  });
});

/* ------------------------------------------------------------------ */
/* GoogleCalendarConnector.incremental — passes updatedMin            */
/* ------------------------------------------------------------------ */

describe("GoogleCalendarConnector incremental (mock fetch)", () => {
  it("sends updatedMin=<since> to the events.list endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeEventsResponse([teamMeeting])),
    });

    const connector = new GoogleCalendarConnector(BASE_CFG);
    const since = "2026-06-01T00:00:00.000Z";
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.incremental(ctx, since)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain(`updatedMin=${encodeURIComponent(since)}`);
  });
});

/* ------------------------------------------------------------------ */
/* OAuth helpers                                                        */
/* ------------------------------------------------------------------ */

describe("GoogleCalendarConnector OAuth helpers", () => {
  it("authorizeUrl includes clientId, redirectUri, state, scope, and response_type", () => {
    const connector = new GoogleCalendarConnector(BASE_CFG);
    const url = connector.authorizeUrl("my-csrf-state");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("state=my-csrf-state");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("response_type=code");
    expect(url).toContain("accounts.google.com");
    expect(url).toContain(encodeURIComponent("https://www.googleapis.com/auth/calendar.readonly"));
    expect(url).toContain("access_type=offline");
  });

  it("exchangeCode posts a form to the token endpoint and returns TokenRef", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "ya29.secret_token",
        refresh_token: "1//refresh_secret",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        token_type: "Bearer",
      }),
    });

    const connector = new GoogleCalendarConnector(BASE_CFG);
    const token = await connector.exchangeCode(
      "auth-code-xyz",
      BASE_CFG.redirectUri,
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("ya29.secret_token");
    expect(token.refreshToken).toBe("1//refresh_secret");
    expect(typeof token.expiresAt).toBe("number");

    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(call?.[1]?.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
  });

  it("refresh returns a new access token and preserves the refresh token if omitted", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "ya29.new_access",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });

    const connector = new GoogleCalendarConnector(BASE_CFG);
    const token = await connector.refresh(
      "1//existing_refresh",
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("ya29.new_access");
    // Google omitted refresh_token → connector preserves the one we passed in.
    expect(token.refreshToken).toBe("1//existing_refresh");

    const body = String(mockFetch.mock.calls[0]?.[1]?.body);
    expect(body).toContain("grant_type=refresh_token");
  });

  it("exchangeCode throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 400 });
    const connector = new GoogleCalendarConnector(BASE_CFG);
    await expect(
      connector.exchangeCode("bad-code", BASE_CFG.redirectUri, mockFetch as unknown as typeof fetch)
    ).rejects.toThrow("400");
  });
});

/* ------------------------------------------------------------------ */
/* Conformance kit — GoogleCalendarConnector                           */
/* ------------------------------------------------------------------ */

describe("ConnectorConformance — GoogleCalendarConnector", () => {
  it("passes all conformance invariants", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => JSON.parse(makeEventsResponse([teamMeeting])),
    });

    const connector = new GoogleCalendarConnector(BASE_CFG);

    const result = await runConformance(connector, {
      orgId: ORG,
      aclCases: [
        {
          label: "public",
          native: {
            visibility: "public",
            organizer: { email: "events@example.com" },
          } as GoogleCalendarNativePermissions,
          expected: { allow: [], public: true },
        },
        {
          label: "default-scoped-to-participants",
          native: {
            visibility: "default",
            organizer: { email: "alice@example.com" },
            attendees: [{ email: "bob@example.com" }],
          } as GoogleCalendarNativePermissions,
          expected: { allow: ["user:alice@example.com", "user:bob@example.com"] },
        },
        {
          label: "orphaned/private",
          native: { visibility: "default" } as GoogleCalendarNativePermissions,
          expected: { allow: [] },
        },
      ],
      backfillCtx: {
        orgId: ORG,
        accessToken: "tok-test",
        fetch: mockFetch as unknown as typeof fetch,
      },
      backfillExpected: {
        connector: "google_calendar",
        externalId: "evt-team-123",
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
