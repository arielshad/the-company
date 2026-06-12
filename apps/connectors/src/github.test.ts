/**
 * GitHubConnector tests (T4.3)
 *
 * All tests use fixture data; NO network calls are made.
 * The fetch function is always injected as a mock.
 */

import { describe, it, expect, vi } from "vitest";
import {
  GitHubConnector,
  githubIssueToIngest,
  mapGitHubAcl,
  parseNextLink,
  type GitHubIssue,
  type GitHubNativePermissions,
  type GitHubConnectorConfig,
} from "./github.js";
import { runConformance } from "./sdk-node.js";
import { ORG } from "@companyos/testing";

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const BASE_CFG: GitHubConnectorConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://app.example/callback",
};

/** An issue in a PUBLIC repo (visible to anyone). */
const publicIssue: GitHubIssue = {
  id: 1001,
  number: 42,
  title: "Public bug report",
  body: "Steps to reproduce...",
  html_url: "https://github.com/acme/widgets/issues/42",
  state: "open",
  created_at: "2026-05-01T10:00:00Z",
  updated_at: "2026-06-01T10:00:00Z",
  repository: {
    full_name: "acme/widgets",
    name: "widgets",
    owner: { login: "acme" },
    private: false,
    visibility: "public",
  },
  user: { login: "octocat" },
};

/** A pull request in a PRIVATE repo (only repo members may see it). */
const privatePr: GitHubIssue = {
  id: 1002,
  number: 7,
  title: "Refactor auth middleware",
  body: "This PR rewrites the auth layer.",
  html_url: "https://github.com/acme/secret-svc/pull/7",
  state: "open",
  created_at: "2026-05-15T08:00:00Z",
  updated_at: "2026-06-02T12:00:00Z",
  pull_request: { html_url: "https://github.com/acme/secret-svc/pull/7" },
  repository: {
    full_name: "acme/secret-svc",
    name: "secret-svc",
    owner: { login: "acme" },
    private: true,
    visibility: "private",
  },
  user: { login: "alice" },
};

/** An issue in an INTERNAL (enterprise-only) repo — NOT world-readable. */
const internalIssue: GitHubIssue = {
  id: 1003,
  number: 3,
  title: "Internal tooling tracker",
  body: "Track internal-only tooling work.",
  html_url: "https://github.com/acme/internal-tools/issues/3",
  state: "open",
  created_at: "2026-05-20T09:00:00Z",
  updated_at: "2026-06-03T09:00:00Z",
  repository: {
    full_name: "acme/internal-tools",
    name: "internal-tools",
    owner: { login: "acme" },
    private: true,
    visibility: "internal",
  },
  user: { login: "bob" },
};

/** An issue whose repo visibility is UNKNOWN/ambiguous → must be denied. */
const ambiguousIssue: GitHubIssue = {
  id: 1004,
  number: 99,
  title: "Mystery repo issue",
  html_url: "https://github.com/acme/mystery/issues/99",
  state: "open",
  created_at: "2026-05-25T09:00:00Z",
  updated_at: "2026-06-04T09:00:00Z",
  repository: {
    full_name: "acme/mystery",
    name: "mystery",
    owner: { login: "acme" },
    // no `private`, no `visibility`
  },
  user: { login: "carol" },
};

/** Build a Headers-like object exposing a get() used by the connector. */
function makeHeaders(map: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return {
    get(name: string): string | null {
      return lower[name.toLowerCase()] ?? null;
    },
  };
}

/** A page response with optional Link header for pagination. */
function makeResponse(issues: GitHubIssue[], linkHeader?: string) {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders(linkHeader ? { Link: linkHeader } : {}),
    json: async () => issues,
  };
}

/* ------------------------------------------------------------------ */
/* mapGitHubAcl — ACL mapping unit tests (case table)                  */
/* ------------------------------------------------------------------ */

describe("mapGitHubAcl", () => {
  const cases: Array<{
    label: string;
    native: GitHubNativePermissions;
    expected: { allow: string[]; public?: boolean };
  }> = [
    {
      label: "public repo (private=false) → public=true, allow=[]",
      native: { fullName: "acme/widgets", private: false, visibility: "public" },
      expected: { allow: [], public: true },
    },
    {
      label: "public repo (visibility=public, no private flag) → public=true",
      native: { fullName: "acme/widgets", visibility: "public" },
      expected: { allow: [], public: true },
    },
    {
      label: "private repo → allow=[repo:owner/name], not public",
      native: { fullName: "acme/secret-svc", private: true, visibility: "private" },
      expected: { allow: ["repo:acme/secret-svc"] },
    },
    {
      label: "internal repo → repo-scoped, NEVER public",
      native: { fullName: "acme/internal-tools", private: true, visibility: "internal" },
      expected: { allow: ["repo:acme/internal-tools"] },
    },
    {
      label: "private repo with no name → DENY (allow=[])",
      native: { private: true },
      expected: { allow: [] },
    },
    {
      label: "unknown visibility → DENY (allow=[], not public)",
      native: { fullName: "acme/mystery" },
      expected: { allow: [] },
    },
    {
      label: "empty native → DENY (allow=[], not public)",
      native: {},
      expected: { allow: [] },
    },
    {
      // Regression: contradictory payload must NOT leak as public.
      label: "contradictory {private:false, visibility:private} → restricted, NOT public",
      native: { fullName: "acme/secret-svc", private: false, visibility: "private" },
      expected: { allow: ["repo:acme/secret-svc"] },
    },
    {
      label: "contradictory {private:false, visibility:internal} → repo-scoped, NOT public",
      native: { fullName: "acme/internal-tools", private: false, visibility: "internal" },
      expected: { allow: ["repo:acme/internal-tools"] },
    },
    {
      label: "malformed full_name with spaces → DENY (no bogus principal)",
      native: { fullName: "a/b user:admin", private: true, visibility: "private" },
      expected: { allow: [] },
    },
  ];

  for (const { label, native, expected } of cases) {
    it(label, () => {
      const acl = mapGitHubAcl(native);
      expect(acl.allow).toEqual(expected.allow);
      expect(Boolean(acl.public)).toBe(Boolean(expected.public));
    });
  }

  it("never returns public=true for any private/internal/unknown input", () => {
    const denyOrScoped: GitHubNativePermissions[] = [
      { fullName: "a/b", private: true },
      { fullName: "a/b", visibility: "private" },
      { fullName: "a/b", visibility: "internal" },
      { fullName: "a/b" },
      {},
    ];
    for (const n of denyOrScoped) {
      expect(mapGitHubAcl(n).public).toBeFalsy();
    }
  });

  it("is deterministic — same input always produces same output", () => {
    const native: GitHubNativePermissions = {
      fullName: "acme/secret-svc",
      private: true,
      visibility: "private",
    };
    const r1 = mapGitHubAcl(native);
    const r2 = mapGitHubAcl(native);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

/* ------------------------------------------------------------------ */
/* githubIssueToIngest — payload mapping                               */
/* ------------------------------------------------------------------ */

describe("githubIssueToIngest", () => {
  it("maps a public issue with public ACL", () => {
    const payload = githubIssueToIngest(publicIssue, ORG);
    expect(payload.orgId).toBe(ORG);
    expect(payload.source.connector).toBe("github");
    expect(payload.source.externalId).toBe("acme/widgets#42");
    expect(payload.source.url).toBe("https://github.com/acme/widgets/issues/42");
    expect(payload.title).toBe("Public bug report");
    expect(payload.sourceAcl?.public).toBe(true);
    expect(payload.sourceAcl?.allow).toEqual([]);
  });

  it("maps a private PR with repo-scoped ACL (not public)", () => {
    const payload = githubIssueToIngest(privatePr, ORG);
    expect(payload.source.externalId).toBe("acme/secret-svc#7");
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual(["repo:acme/secret-svc"]);
    expect(payload.content).toContain("Type: Pull Request");
  });

  it("maps an internal issue as repo-scoped, never public", () => {
    const payload = githubIssueToIngest(internalIssue, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual(["repo:acme/internal-tools"]);
  });

  it("maps an ambiguous-visibility issue as denied (allow=[], not public)", () => {
    const payload = githubIssueToIngest(ambiguousIssue, ORG);
    expect(payload.sourceAcl?.public).toBeFalsy();
    expect(payload.sourceAcl?.allow).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* parseNextLink — Link-header pagination                              */
/* ------------------------------------------------------------------ */

describe("parseNextLink", () => {
  it("extracts rel=next from a multi-rel Link header", () => {
    const header =
      '<https://api.github.com/issues?page=2>; rel="next", ' +
      '<https://api.github.com/issues?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/issues?page=2");
  });

  it("returns null when there is no next rel", () => {
    const header = '<https://api.github.com/issues?page=1>; rel="prev"';
    expect(parseNextLink(header)).toBeNull();
  });

  it("returns null for an empty/absent header", () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink(undefined)).toBeNull();
    expect(parseNextLink("")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* GitHubConnector.backfill — with injected mock fetch                 */
/* ------------------------------------------------------------------ */

describe("GitHubConnector backfill (mock fetch, no network)", () => {
  it("yields one IngestPayload per issue/PR", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([publicIssue, privatePr]));

    const connector = new GitHubConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results: ReturnType<typeof githubIssueToIngest>[] = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.source.externalId).toBe("acme/widgets#42");
    expect(results[1]?.source.externalId).toBe("acme/secret-svc#7");
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify Bearer auth + GitHub Accept header were sent (never logged here).
    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe("Bearer tok-test");
    expect(headers?.["Accept"]).toBe("application/vnd.github+json");
  });

  it("skips malformed items missing a number (trashed/defensive skip)", async () => {
    const malformed = { ...privatePr } as GitHubIssue;
    // Simulate a trashed/malformed item with no usable number.
    delete (malformed as { number?: number }).number;

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([malformed, publicIssue]));

    const connector = new GitHubConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }
    expect(results).toHaveLength(1);
    expect(results[0]?.source.externalId).toBe("acme/widgets#42");
  });

  it("paginates by following the Link rel=next header", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(
          [publicIssue],
          '<https://api.github.com/issues?page=2&per_page=100>; rel="next"'
        )
      )
      .mockResolvedValueOnce(makeResponse([privatePr])); // no Link → stop

    const connector = new GitHubConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };

    const results = [];
    for await (const item of connector.backfill(ctx)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The second call must hit the exact URL from the Link header.
    expect(mockFetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/issues?page=2&per_page=100"
    );
  });

  it("throws on HTTP error", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, headers: makeHeaders({}) });
    const connector = new GitHubConnector(BASE_CFG);
    const ctx = { orgId: ORG, accessToken: "bad-tok", fetch: mockFetch as unknown as typeof fetch };

    const gen = connector.backfill(ctx);
    await expect(gen.next()).rejects.toThrow("401");
  });
});

/* ------------------------------------------------------------------ */
/* GitHubConnector.incremental — filters by updated_at                 */
/* ------------------------------------------------------------------ */

describe("GitHubConnector incremental (mock fetch)", () => {
  it("sends the `since` param and skips items not updated after `since`", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([publicIssue, privatePr]));

    const connector = new GitHubConnector(BASE_CFG);
    // publicIssue.updated_at = "2026-06-01T10:00:00Z"
    // privatePr.updated_at   = "2026-06-02T12:00:00Z"
    const since = "2026-06-01T11:00:00Z"; // only privatePr should pass

    const results = [];
    const ctx = { orgId: ORG, accessToken: "tok-test", fetch: mockFetch as unknown as typeof fetch };
    for await (const item of connector.incremental(ctx, since)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.source.externalId).toBe("acme/secret-svc#7");

    // The `since` query param must be passed to the GitHub API.
    const firstUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(firstUrl).toContain(`since=${encodeURIComponent(since)}`);
  });
});

/* ------------------------------------------------------------------ */
/* OAuth helpers                                                        */
/* ------------------------------------------------------------------ */

describe("GitHubConnector OAuth helpers", () => {
  it("authorizeUrl includes clientId, redirectUri, scope, and state", () => {
    const connector = new GitHubConnector(BASE_CFG);
    const url = connector.authorizeUrl("my-csrf-state");
    expect(url).toContain("github.com/login/oauth/authorize");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("state=my-csrf-state");
    expect(url).toContain("redirect_uri=");
    // scope "repo read:org" → URL-encoded
    expect(url).toContain("scope=repo+read%3Aorg");
  });

  it("exchangeCode posts JSON and returns TokenRef (no refresh token)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "gho_secret_token",
        token_type: "bearer",
        scope: "repo,read:org",
      }),
    });

    const connector = new GitHubConnector(BASE_CFG);
    const token = await connector.exchangeCode(
      "auth-code-xyz",
      BASE_CFG.redirectUri,
      mockFetch as unknown as typeof fetch
    );

    expect(token.accessToken).toBe("gho_secret_token");
    expect(token.refreshToken).toBeUndefined();
    expect(token.scope).toBe("repo,read:org");

    // Verify we asked GitHub for a JSON response.
    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Accept"]).toBe("application/json");
  });

  it("exchangeCode throws on GitHub's HTTP-200 error body", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      }),
    });
    const connector = new GitHubConnector(BASE_CFG);
    await expect(
      connector.exchangeCode("bad", BASE_CFG.redirectUri, mockFetch as unknown as typeof fetch)
    ).rejects.toThrow("bad_verification_code");
  });

  it("refresh throws (GitHub tokens do not expire)", async () => {
    const connector = new GitHubConnector(BASE_CFG);
    await expect(connector.refresh("any-token")).rejects.toThrow("re-authorize");
  });
});

/* ------------------------------------------------------------------ */
/* Conformance kit — GitHubConnector                                   */
/* ------------------------------------------------------------------ */

describe("ConnectorConformance — GitHubConnector", () => {
  it("passes all conformance invariants", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeResponse([publicIssue]));

    const connector = new GitHubConnector(BASE_CFG);

    const result = await runConformance(connector, {
      orgId: ORG,
      aclCases: [
        {
          label: "public-repo",
          native: {
            fullName: "acme/widgets",
            private: false,
            visibility: "public",
          } as GitHubNativePermissions,
          expected: { allow: [], public: true },
        },
        {
          label: "private-repo",
          native: {
            fullName: "acme/secret-svc",
            private: true,
            visibility: "private",
          } as GitHubNativePermissions,
          expected: { allow: ["repo:acme/secret-svc"] },
        },
        {
          label: "unknown/denied",
          native: { fullName: "acme/mystery" } as GitHubNativePermissions,
          expected: { allow: [] },
        },
      ],
      backfillCtx: {
        orgId: ORG,
        accessToken: "tok-test",
        fetch: mockFetch as unknown as typeof fetch,
      },
      backfillExpected: {
        connector: "github",
        externalId: "acme/widgets#42",
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
