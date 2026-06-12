/**
 * GitHubConnector (T4.3)
 *
 * Read-only OAuth connector for GitHub issues + pull requests.
 * - auth-code OAuth against https://github.com/login/oauth/
 * - backfill via GET https://api.github.com/issues (issues + PRs across visible repos)
 * - incremental via the `since` query param + client-side updated_at filter
 * - mapAcl: CONSERVATIVE mapping of GitHub repo visibility to SourceAcl
 *
 * Design: all secrets/tokens injected; fetch injected; no network in tests.
 * Token logging is explicitly prohibited — never log accessToken/refreshToken.
 *
 * GitHub access tokens (classic OAuth-app tokens) do not expire, so refresh()
 * throws and the caller must treat expiry/revocation as "re-authorize".
 */

import type { SourceRef } from "@companyos/schemas";
import type {
  SourceConnector,
  IngestPayload,
  SourceAcl,
  NativePermissions,
  SyncContext,
  OAuthCapable,
  BackfillCapable,
  IncrementalCapable,
  AclCapable,
  TokenRef,
} from "./sdk.js";

/* ------------------------------------------------------------------ */
/* GitHub-specific config (injected, never logged)                      */
/* ------------------------------------------------------------------ */

export interface GitHubConnectorConfig {
  /** OAuth client id */
  clientId: string;
  /** OAuth client secret — never log */
  clientSecret: string;
  /** e.g. https://yourapp.example/api/connectors/github/callback */
  redirectUri: string;
  /** OAuth scopes, default "repo read:org" */
  scope?: string;
}

/* ------------------------------------------------------------------ */
/* GitHub API response shapes (minimal, for parsing)                   */
/* ------------------------------------------------------------------ */

/** A GitHub repository as embedded in an issue payload. */
export interface GitHubRepo {
  /** "owner/name" */
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  /** GitHub's canonical visibility marker. */
  private?: boolean;
  /** Newer field: "public" | "private" | "internal". */
  visibility?: string;
}

/** A GitHub issue or pull request (the /issues endpoint returns both). */
export interface GitHubIssue {
  id: number;
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  /** ISO-8601 */
  updated_at?: string;
  /** ISO-8601 */
  created_at?: string;
  /** Present (truthy) when this issue is actually a pull request. */
  pull_request?: { url?: string; html_url?: string };
  repository?: GitHubRepo;
  user?: { login?: string };
}

/**
 * GitHub "native permissions" object passed to mapAcl.
 *
 * Derived from the repository carrying the issue. We deliberately key the ACL
 * decision off repo visibility, which is the security boundary GitHub enforces:
 * a private repo's issues are visible only to repo members; a public repo's
 * issues are visible to anyone.
 */
export interface GitHubNativePermissions extends Record<string, unknown> {
  /** "owner/name" — used to build the repo:<owner>/<name> ACL principal. */
  fullName?: string;
  /** GitHub's `private` boolean on the repository. */
  private?: boolean;
  /** GitHub's `visibility` string: "public" | "private" | "internal". */
  visibility?: string;
}

/** GitHub OAuth token response (Accept: application/json). */
interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  /** Present only on error (e.g. "bad_verification_code"). */
  error?: string;
  error_description?: string;
}

/* ------------------------------------------------------------------ */
/* ACL mapping helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Map a GitHub repository's visibility to SourceAcl.
 *
 * ACL-mapping decisions (security-critical — when in doubt, DENY):
 *
 * 1. A repo is treated as PUBLIC only when GitHub EXPLICITLY says so:
 *    `private === false` OR `visibility === "public"`. Only then do we set
 *    public=true, allow=[] (anyone can read the issue).
 *
 * 2. A repo is treated as PRIVATE (incl. "internal", which is org-scoped, not
 *    world-readable) when `private === true` OR `visibility` is "private"
 *    or "internal". We grant exactly one principal: "repo:<owner>/<name>",
 *    which the identity layer resolves to the repo's members. allow is never
 *    set to a broad/public value here.
 *
 * 3. CONSERVATIVE DEFAULT: if visibility is unknown/ambiguous (no `private`
 *    boolean, unrecognized `visibility`, missing repo name), we DENY:
 *    allow=[], public=false. We NEVER fall back to public, and we never emit
 *    a repo principal we cannot name (an unnamed repo grant would be
 *    meaningless and could be mis-resolved).
 *
 * Invariants (enforced by conformance tests):
 * - Deterministic: same input → same output.
 * - Least-privilege: never grant access not present in the source.
 * - No accidental public: public=true ONLY when visibility is explicitly public.
 */
export function mapGitHubAcl(native: GitHubNativePermissions): SourceAcl {
  // Any restriction signal wins (AND-semantics): a repo is private/internal if
  // `private === true` OR visibility says private/internal. Computed FIRST so a
  // contradictory payload like {private:false, visibility:"private"} can never
  // leak as public — restricted always beats a looser sibling field.
  // "internal" repos are visible only to enterprise members, NOT the world.
  const isExplicitlyRestricted =
    native.private === true ||
    native.visibility === "private" ||
    native.visibility === "internal";

  if (isExplicitlyRestricted) {
    // Only emit a principal if we can name the repo safely; otherwise deny.
    // Strict owner/name shape so a malformed full_name can't become a bogus,
    // over-broad principal at the authz layer.
    if (native.fullName && /^[^/\s]+\/[^/\s]+$/.test(native.fullName)) {
      return { allow: [`repo:${native.fullName}`] };
    }
    return { allow: [] };
  }

  // Explicit public — the ONLY path to public=true, and only when NOT restricted.
  if (native.private === false || native.visibility === "public") {
    return { allow: [], public: true };
  }

  // Unknown/ambiguous visibility → DENY (never accidentally public).
  return { allow: [] };
}

/* ------------------------------------------------------------------ */
/* Title / content extraction                                           */
/* ------------------------------------------------------------------ */

function isPullRequest(issue: GitHubIssue): boolean {
  return Boolean(issue.pull_request);
}

function repoFullName(issue: GitHubIssue): string | undefined {
  const repo = issue.repository;
  if (!repo) return undefined;
  if (repo.full_name) return repo.full_name;
  if (repo.owner?.login && repo.name) return `${repo.owner.login}/${repo.name}`;
  return undefined;
}

function extractTitle(issue: GitHubIssue): string {
  const kind = isPullRequest(issue) ? "PR" : "Issue";
  const ref = externalIdFor(issue) ?? `#${issue.number}`;
  const title = issue.title?.trim();
  return title ? `${title}` : `${kind} ${ref}`;
}

function extractContent(issue: GitHubIssue): string {
  const parts: string[] = [];
  if (issue.title) parts.push(issue.title);
  const kind = isPullRequest(issue) ? "Pull Request" : "Issue";
  const repo = repoFullName(issue);
  const meta: string[] = [`Type: ${kind}`];
  if (repo) meta.push(`Repo: ${repo}`);
  if (issue.state) meta.push(`State: ${issue.state}`);
  if (issue.user?.login) meta.push(`Author: ${issue.user.login}`);
  if (issue.created_at) meta.push(`Created: ${issue.created_at}`);
  if (issue.updated_at) meta.push(`Updated: ${issue.updated_at}`);
  parts.push(meta.join("\n"));
  if (issue.body) parts.push(issue.body);
  return parts.join("\n\n");
}

/** Build "<owner>/<repo>#<number>" if the repo name is known. */
function externalIdFor(issue: GitHubIssue): string | undefined {
  const repo = repoFullName(issue);
  if (!repo) return undefined;
  return `${repo}#${issue.number}`;
}

/* ------------------------------------------------------------------ */
/* Map a GitHub issue/PR to IngestPayload                               */
/* ------------------------------------------------------------------ */

export function githubIssueToIngest(
  issue: GitHubIssue,
  orgId: string
): IngestPayload {
  const title = extractTitle(issue);
  const content = extractContent(issue);

  // Stable externalId; fall back to the numeric id when repo is unknown so we
  // never emit an empty/colliding identifier.
  const externalId = externalIdFor(issue) ?? `issue:${issue.id}`;

  const source: SourceRef = {
    connector: "github",
    externalId,
    url: issue.html_url,
  };

  const native: GitHubNativePermissions = {
    fullName: repoFullName(issue),
    private: issue.repository?.private,
    visibility: issue.repository?.visibility,
  };
  const sourceAcl = mapGitHubAcl(native);

  return { orgId, source, title, content, sourceAcl };
}

/* ------------------------------------------------------------------ */
/* Link-header parsing (GitHub pagination)                              */
/* ------------------------------------------------------------------ */

/**
 * Parse a GitHub `Link` header and return the URL for rel="next", if any.
 * Example header:
 *   <https://api.github.com/issues?page=2>; rel="next",
 *   <https://api.github.com/issues?page=5>; rel="last"
 */
export function parseNextLink(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const segment = part.trim();
    const match = /^<([^>]+)>\s*;\s*(.+)$/.exec(segment);
    if (!match) continue;
    const url = match[1];
    const params = match[2];
    if (url && params && /\brel\s*=\s*"?next"?/.test(params)) {
      return url;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* GitHubConnector                                                      */
/* ------------------------------------------------------------------ */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_ISSUES_URL = `${GITHUB_API_BASE}/issues`;
const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN = "https://github.com/login/oauth/access_token";
const DEFAULT_SCOPE = "repo read:org";
const GITHUB_API_VERSION = "2022-11-28";
const PER_PAGE = 100;

export class GitHubConnector
  implements SourceConnector, OAuthCapable, BackfillCapable, IncrementalCapable, AclCapable
{
  readonly name = "github";
  private readonly cfg: GitHubConnectorConfig;
  private readonly scope: string;

  constructor(cfg: GitHubConnectorConfig) {
    this.cfg = cfg;
    this.scope = cfg.scope ?? DEFAULT_SCOPE;
  }

  /* -- OAuth -- */

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: this.scope,
      state,
    });
    return `${GITHUB_OAUTH_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    fetchFn?: typeof fetch
  ): Promise<TokenRef> {
    const f = fetchFn ?? globalThis.fetch;

    const res = await f(GITHUB_OAUTH_TOKEN, {
      method: "POST",
      headers: {
        // Ask GitHub for JSON instead of the default form-encoded body.
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`github: exchangeCode failed ${res.status}`);
    }
    const data = (await res.json()) as GitHubTokenResponse;
    // GitHub returns HTTP 200 with an `error` field on auth-code failures.
    if (data.error || !data.access_token) {
      // NEVER log token fields; the error code is safe to surface.
      throw new Error(`github: exchangeCode error ${data.error ?? "no_access_token"}`);
    }
    // NEVER log data.access_token
    return {
      accessToken: data.access_token,
      scope: data.scope,
      // GitHub OAuth-app tokens do not expire and have no refresh token.
    };
  }

  async refresh(
    _refreshToken: string,
    _fetchFn?: typeof fetch
  ): Promise<TokenRef> {
    // GitHub OAuth-app access tokens do not expire and are not refreshable.
    // Callers should treat expiry/revocation as "re-authorize".
    throw new Error("github: token refresh not supported; re-authorize via OAuth");
  }

  /* -- ACL mapping -- */

  mapAcl(nativePermissions: NativePermissions): SourceAcl {
    return mapGitHubAcl(nativePermissions as unknown as GitHubNativePermissions);
  }

  /* -- Backfill -- */

  async *backfill(ctx: SyncContext): AsyncGenerator<IngestPayload> {
    yield* this.#listIssues(ctx, undefined);
  }

  /* -- Incremental -- */

  async *incremental(ctx: SyncContext, since: string): AsyncGenerator<IngestPayload> {
    yield* this.#listIssues(ctx, since);
  }

  /* -- Internal: paged list of issues + PRs across visible repos -- */

  async *#listIssues(
    ctx: SyncContext,
    since: string | undefined
  ): AsyncGenerator<IngestPayload> {
    const f = ctx.fetch ?? globalThis.fetch;

    // Initial URL: all issues/PRs the token can see, across owned/member repos.
    const params = new URLSearchParams({
      filter: "all",
      state: "all",
      per_page: String(PER_PAGE),
      sort: "updated",
      direction: "desc",
    });
    if (since) {
      // GitHub honors `since` server-side (ISO-8601, updated_at >= since).
      params.set("since", since);
    }
    let nextUrl: string | null = `${GITHUB_ISSUES_URL}?${params.toString()}`;

    while (nextUrl !== null) {
      const res = await f(nextUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      });

      if (!res.ok) {
        throw new Error(`github: list issues failed ${res.status}`);
      }

      const issues = (await res.json()) as GitHubIssue[];

      for (const issue of issues) {
        // Skip items closed-and-locked-as-trash sentinels we cannot ingest:
        // GitHub does not expose a hard "trashed" flag on issues, but a missing
        // number/id is malformed — skip defensively.
        if (typeof issue.number !== "number") continue;

        // Incremental filter: GitHub `since` is >= (inclusive); we want strictly
        // newer than `since`, so drop items whose updated_at <= since.
        if (since && issue.updated_at && issue.updated_at <= since) {
          continue;
        }

        yield githubIssueToIngest(issue, ctx.orgId);
      }

      nextUrl = parseNextLink(res.headers?.get("Link") ?? res.headers?.get("link"));
    }
  }
}
