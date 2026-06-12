/**
 * GoogleDriveConnector tests (T4.x)
 *
 * All tests use fixture data; NO network calls are made.
 * The fetch function is always injected as a mock.
 */

import { describe, it, expect, vi } from "vitest";
import {
  GoogleDriveConnector,
  driveFileToIngest,
  mapGoogleDriveAcl,
  type DriveFile,
  type GoogleDriveNativePermissions,
  type GoogleDriveConnectorConfig,
} from "./drive.js";
import { runConformance } from "./sdk-node.js";
import { ORG } from "@companyos/testing";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const BASE_CFG: GoogleDriveConnectorConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://app.example/callback",
};

/** A file shared with "anyone" (public on the web). */
const publicFile: DriveFile = {
  id: "file-public-123",
  name: "Public Roadmap",
  mimeType: "application/pdf",
  modifiedTime: "2026-06-01T10:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/file-public-123/view",
  permissions: [{ type: "anyone", role: "reader" }],
  trashed: false,
};

/** A file restricted to two specific users. */
const restrictedFile: DriveFile = {
  id: "file-restricted-456",
  name: "Q3 Strategy (Confidential)",
  mimeType: "application/pdf",
  modifiedTime: "2026-06-02T12:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/file-restricted-456/view",
  permissions: [
    { type: "user", emailAddress: "alice@acme.com", role: "writer" },
    { type: "user", emailAddress: "bob@acme.com", role: "reader" },
  ],
  trashed: false,
};

/** A file shared with a whole Workspace domain. */
const domainFile: DriveFile = {
  id: "file-domain-789",
  name: "Company Handbook",
  mimeType: "application/vnd.google-apps.document",
  modifiedTime: "2026-06-03T09:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/file-domain-789/view",
  permissions: [{ type: "domain", domain: "acme.com", role: "reader" }],
  trashed: false,
};

/** A file with no permissions array (orphaned/private). */
const privateFile: DriveFile = {
  id: "file-private-000",
  name: "Personal Notes",
  mimeType: "text/plain",
  modifiedTime: "2026-06-04T09:00:00.000Z",
  webViewLink: "https://drive.google.com/file/d/file-private-000/view",
  trashed: false,
};

/** A Google Drive files.list response. */
function makeListResponse(files: DriveFile[], nextPageToken?: string) {
  return JSON.stringify({ files, nextPageToken });
}

/* ------------------------------------------------------------------ */
/* mapGoogleDriveAcl — ACL mapping unit tests (case table)             */
/* ------------------------------------------------------------------ */

describe("mapGoogleDriveAcl", () => {
  const cases: Array<{
    label: string;
    native: GoogleDriveNativePermissions;
    expected: { allow: string[]; public?: boolean };
  }> = [
    {
      label: "anyone → public=true, allow=[]",
      native: { permissions: [{ type: "anyone", role: "reader" }] },
      expected: { allow: [], public: true },
    },
    {
      label: "domain → allow domain:<domain>",
      native: { permissions: [{ type: "domain", domain: "acme.com" }] },
      expected: { allow: ["domain:acme.com"] },
    },
    {
      label: "user → allow user:<email>",
      native: { permissions: [{ type: "user", emailAddress: "alice@acme.com" }] },
      expected: { allow: ["user:alice@acme.com"] },
    },
    {
      label: "group → allow group:<email>",
      native: { permissions: [{ type: "group", emailAddress: "eng@acme.com" }] },
      expected: { allow: ["group:eng@acme.com"] },
    },
    {
      label: "missing permissions → deny (allow=[])",
      native: {},
      expected: { allow: [] },
    },
    {
      label: "empty permissions → deny (allow=[])",
      native: { permissions: [] },
      expected: { allow: [] },
    },
    {
      label: "user without emailAddress → skipped (deny)",
      native: { permissions: [{ type: "user" }] },
      expected: { allow: [] },
    },
    {
      label: "domain without domain field → skipped (deny)",
      native: { permissions: [{ type: "domain" }] },
      expected: { allow: [] },
    },
    {
      label: "unknown type → skipped (deny)",
      native: { permissions: [{ type: "fileOrganizer" }] },
      expected: { allow: [] },
    },
    {
      label: "anyone wins even mixed with users (still public)",
      native: {
        permissions: [
          { type: "user", emailAddress: "alice@acme.com" },
          { type: "anyone" },
        ],
      },
      expected: { allow: [], public: true },
    },
    {
      label: "mixed user + group + domain",
      native: {
        permissions: [
          { type: "user", emailAddress: "alice@acme.com" },
          { type: "group", emailAddress: "eng@acme.com" },
          { type: "domain", domain: "acme.com" },
        ],
      },
      expected: {
        allow: ["domain:acme.com", "group:eng@acme.com", "user:alice@acme.com"],
      },
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const acl = mapGoogleDriveAcl(c.native);
      expect([...acl.allow].sort()).toEqual([...c.expected.allow].sort());
      expect(!!acl.public).toBe(!!c.expected.public);
    });
  }

  it("is deterministic — same input always produces same output", () => {
    const native: GoogleDriveNativePermissions = {
      permissions: [{ type: "user", emailAddress: "u1@acme.com" }],
    };
    const r1 = mapGoogleDriveAcl(native);
    const r2 = mapGoogleDriveAcl(native);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("deduplicated and sorted — same user listed twice → single entry", () => {
    const acl = mapGoogleDriveAcl({
      permissions: [
        { type: "user", emailAddress: "u1@acme.com", role: "writer" },
        { type: "user", emailAddress: "u1@acme.com", role: "reader" },
      ],
    });
    expect(acl.allow).toEqual(["user:u1@acme.com"]);
  });
});

/* ------------------------------------------------------------------ */
/* driveFileToIngest — payload mapping                                 */
/* ------------------------------------------------------------------ */

describe("driveFileToIngest", () => {
  it("maps a public file correctly", () => {
    const payload = driveFileToIngest(publicFile, ORG);
    expect(payload.orgId).toBe(ORG);
    expect(payload.source.connector).toBe("google_drive");
    expect(payload.source.externalId).toBe("file-public-123");
    expect(payload.source.url).toBe(publicFile.webViewLink);
    expect(payload.title).toBe("Public Roadmap");
    expect(payload.sourceAcl?.public).toBe(true);
    expect(payload.sourceAcl?.allow).toEqual([]);
  });

  it("maps a restricted file with two users", () => {
    const payload = driveFileToIngest(restrictedFile, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toContain("user:alice@acme.com");
    expect(payload.sourceAcl?.allow).toContain("user:bob@acme.com");
    expect(payload.title).toBe("Q3 Strategy (Confidential)");
  });

  it("maps a domain-shared file", () => {
    const payload = driveFileToIngest(domainFile, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual(["domain:acme.com"]);
  });

  it("maps a private file with no permissions (deny)", () => {
    const payload = driveFileToIngest(privateFile, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([]);
  });

  it("uses exported text as content when provided", () => {
    const payload = driveFileToIngest(domainFile, ORG, "Hello from the doc body");
    expect(payload.content).toBe("Hello from the doc body");
  });
});

/* ------------------------------------------------------------------ */
/* GoogleDriveConnector.backfill — with injected mock fetch            */
/* ------------------------------------------------------------------ */

describe("GoogleDriveConnector backfill (mock fetch, no network)", () => {
  it("yields one IngestPayload per non-trashed file", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeListResponse([publicFile, restrictedFile])),
    });

    const connector = new GoogleDriveConnector(BASE_CFG);
    const ctx = {
      orgId: ORG,
      accessToken: "tok-test",
      fetch: mockFetch as unknown as typeof fetch,
    };

    const results: ReturnType<typeof driveFileToIngest>[] = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.source.externalId).toBe("file-public-123");
    expect(results[1]?.source.externalId).toBe("file-restricted-456");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("exports Google Docs as text (extra export fetch)", async () => {
    const mockFetch = vi
      .fn()
      // files.list returns one Google Doc
      .mockResolvedValueOnce({
        ok: true,
        json: async () => JSON.parse(makeListResponse([domainFile])),
      })
      // /export returns the doc body as text
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "Exported document body",
      });

    const connector = new GoogleDriveConnector(BASE_CFG);
    const ctx = {
      orgId: ORG,
      accessToken: "tok-test",
      fetch: mockFetch as unknown as typeof fetch,
    };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("Exported document body");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The export call should target the export endpoint with text/plain.
    const exportUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(exportUrl).toContain(`/files/${domainFile.id}/export`);
    expect(exportUrl).toContain("mimeType=text%2Fplain");
  });

  it("skips trashed files", async () => {
    const trashedFile: DriveFile = { ...restrictedFile, trashed: true };
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeListResponse([trashedFile])),
    });

    const connector = new GoogleDriveConnector(BASE_CFG);
    const ctx = {
      orgId: ORG,
      accessToken: "tok-test",
      fetch: mockFetch as unknown as typeof fetch,
    };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }
    expect(results).toHaveLength(0);
  });

  it("paginates when nextPageToken is present", async () => {
    const page1 = JSON.stringify({
      files: [publicFile],
      nextPageToken: "token-abc",
    });
    const page2 = JSON.stringify({
      files: [restrictedFile],
      // no nextPageToken → last page
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => JSON.parse(page1) })
      .mockResolvedValueOnce({ ok: true, json: async () => JSON.parse(page2) });

    const connector = new GoogleDriveConnector(BASE_CFG);
    const ctx = {
      orgId: ORG,
      accessToken: "tok-test",
      fetch: mockFetch as unknown as typeof fetch,
    };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The second call should carry the pageToken from page 1.
    const secondCallUrl = mockFetch.mock.calls[1]?.[0] as string;
    expect(secondCallUrl).toContain("pageToken=token-abc");
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    const connector = new GoogleDriveConnector(BASE_CFG);
    const ctx = {
      orgId: ORG,
      accessToken: "bad-tok",
      fetch: mockFetch as unknown as typeof fetch,
    };

    const gen = connector.backfill(ctx);
    await expect(gen.next()).rejects.toThrow("401");
  });
});

/* ------------------------------------------------------------------ */
/* GoogleDriveConnector.incremental — filters by modifiedTime          */
/* ------------------------------------------------------------------ */

describe("GoogleDriveConnector incremental (mock fetch)", () => {
  it("skips files not modified after `since`", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeListResponse([publicFile, restrictedFile])),
    });

    const connector = new GoogleDriveConnector(BASE_CFG);
    // publicFile.modifiedTime     = "2026-06-01T10:00:00.000Z"
    // restrictedFile.modifiedTime = "2026-06-02T12:00:00.000Z"
    const since = "2026-06-01T11:00:00.000Z"; // only restrictedFile should pass

    const results = [];
    const ctx = {
      orgId: ORG,
      accessToken: "tok-test",
      fetch: mockFetch as unknown as typeof fetch,
    };
    for await (const item of connector.incremental(ctx, since)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.source.externalId).toBe("file-restricted-456");
  });

  it("includes the modifiedTime filter in the query", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => JSON.parse(makeListResponse([])),
    });
    const connector = new GoogleDriveConnector(BASE_CFG);
    const since = "2026-06-01T11:00:00.000Z";
    const ctx = {
      orgId: ORG,
      accessToken: "tok-test",
      fetch: mockFetch as unknown as typeof fetch,
    };
    for await (const _ of connector.incremental(ctx, since)) {
      /* drain */
    }
    // URLSearchParams encodes spaces as "+"; normalize before asserting on the q clause.
    const url = decodeURIComponent(mockFetch.mock.calls[0]?.[0] as string).replace(/\+/g, " ");
    expect(url).toContain(`modifiedTime > '${since}'`);
    expect(url).toContain("trashed = false");
  });
});

/* ------------------------------------------------------------------ */
/* OAuth helpers                                                        */
/* ------------------------------------------------------------------ */

describe("GoogleDriveConnector OAuth helpers", () => {
  it("authorizeUrl includes clientId, redirectUri, state, scope, response_type", () => {
    const connector = new GoogleDriveConnector(BASE_CFG);
    const url = connector.authorizeUrl("my-csrf-state");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("state=my-csrf-state");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("response_type=code");
    expect(url).toContain("accounts.google.com");
    expect(decodeURIComponent(url)).toContain(
      "https://www.googleapis.com/auth/drive.readonly"
    );
    expect(url).toContain("access_type=offline");
  });

  it("exchangeCode posts form body and returns TokenRef with refresh token", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        token_type: "Bearer",
      }),
    });

    const connector = new GoogleDriveConnector(BASE_CFG);
    const token = await connector.exchangeCode(
      "auth-code-xyz",
      BASE_CFG.redirectUri,
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("ya29.access");
    expect(token.refreshToken).toBe("1//refresh");
    expect(typeof token.expiresAt).toBe("number");

    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toBe("https://oauth2.googleapis.com/token");
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = call?.[1]?.body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
  });

  it("refresh exchanges a refresh token and preserves it when not reissued", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "ya29.newaccess",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });

    const connector = new GoogleDriveConnector(BASE_CFG);
    const token = await connector.refresh(
      "1//refresh",
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("ya29.newaccess");
    // Google did not reissue a refresh token → keep the one we passed in.
    expect(token.refreshToken).toBe("1//refresh");

    const body = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(body).toContain("grant_type=refresh_token");
  });

  it("refresh throws on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 400 });
    const connector = new GoogleDriveConnector(BASE_CFG);
    await expect(
      connector.refresh("bad-token", mockFetch as unknown as typeof fetch)
    ).rejects.toThrow("400");
  });
});

/* ------------------------------------------------------------------ */
/* Conformance kit — GoogleDriveConnector                              */
/* ------------------------------------------------------------------ */

describe("ConnectorConformance — GoogleDriveConnector", () => {
  it("passes all conformance invariants", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => JSON.parse(makeListResponse([publicFile])),
    });

    const connector = new GoogleDriveConnector(BASE_CFG);

    const result = await runConformance(connector, {
      orgId: ORG,
      aclCases: [
        {
          label: "anyone-public",
          native: {
            permissions: [{ type: "anyone", role: "reader" }],
          } as GoogleDriveNativePermissions,
          expected: { allow: [], public: true },
        },
        {
          label: "restricted-to-user",
          native: {
            permissions: [{ type: "user", emailAddress: "u1@acme.com" }],
          } as GoogleDriveNativePermissions,
          expected: { allow: ["user:u1@acme.com"] },
        },
        {
          label: "domain-shared",
          native: {
            permissions: [{ type: "domain", domain: "acme.com" }],
          } as GoogleDriveNativePermissions,
          expected: { allow: ["domain:acme.com"] },
        },
        {
          label: "private/orphaned",
          native: {} as GoogleDriveNativePermissions,
          expected: { allow: [] },
        },
      ],
      backfillCtx: {
        orgId: ORG,
        accessToken: "tok-test",
        fetch: mockFetch as unknown as typeof fetch,
      },
      backfillExpected: {
        connector: "google_drive",
        externalId: "file-public-123",
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
