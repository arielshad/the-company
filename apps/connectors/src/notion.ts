/**
 * NotionConnector (T4.2)
 *
 * Read-only OAuth connector for Notion.
 * - auth-code OAuth against https://api.notion.com/v1/oauth/
 * - backfill via POST /v1/search (pages + databases)
 * - incremental via last_edited_time filter
 * - mapAcl: conservative mapping of Notion's permission model to SourceAcl
 *
 * Design: all secrets/tokens injected; fetch injected; no network in tests.
 * Token logging is explicitly prohibited — never log accessToken/refreshToken.
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
/* Notion-specific config (injected, never logged)                      */
/* ------------------------------------------------------------------ */

export interface NotionConnectorConfig {
  /** OAuth client id */
  clientId: string;
  /** OAuth client secret — never log */
  clientSecret: string;
  /** e.g. https://yourapp.example/api/connectors/notion/callback */
  redirectUri: string;
  /** Notion API version header, default "2022-06-28" */
  notionVersion?: string;
}

/* ------------------------------------------------------------------ */
/* Notion API response shapes (minimal, for parsing)                   */
/* ------------------------------------------------------------------ */

/** A "person" user in Notion's API. */
interface NotionPersonUser {
  object: "user";
  id: string;
  type: "person";
  person?: { email?: string };
  name?: string;
}

/** A "bot" user in Notion's API. */
interface NotionBotUser {
  object: "user";
  id: string;
  type: "bot";
  name?: string;
}

type NotionUser = NotionPersonUser | NotionBotUser;

/** Notion workspace-level permission (visible to all workspace members). */
interface NotionWorkspacePermission {
  type: "workspace";
  workspace: true;
}

/** Notion user-level permission. */
interface NotionUserPermission {
  type: "user";
  user: NotionUser;
  role: string;
}

/** Notion group/role-level permission (Notion Enterprise). */
interface NotionGroupPermission {
  type: "group";
  group: { id: string; name?: string };
  role: string;
}

/** A permission object for a page or database. */
export type NotionPermission =
  | NotionWorkspacePermission
  | NotionUserPermission
  | NotionGroupPermission;

/** Notion "native permissions" object passed to mapAcl. */
export interface NotionNativePermissions extends Record<string, unknown> {
  /** The permissions array from the Notion object's `permissions` field. */
  permissions: NotionPermission[];
  /** Whether the page is public on the internet (Notion public URL sharing). */
  publicUrl?: boolean;
}

/** A Notion page/database result from the search API. */
export interface NotionPageResult {
  object: "page" | "database";
  id: string;
  url?: string;
  /** ISO-8601 */
  last_edited_time?: string;
  /** ISO-8601 */
  created_time?: string;
  properties?: Record<string, unknown>;
  title?: Array<{ plain_text?: string }>;
  permissions?: NotionPermission[];
  /** Workspace-level sharing */
  public_url?: string | null;
  archived?: boolean;
}

/** Notion search API response. */
interface NotionSearchResponse {
  results: NotionPageResult[];
  next_cursor: string | null;
  has_more: boolean;
}

/** Notion OAuth token response. */
interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  workspace_icon?: string;
  owner?: unknown;
}

/* ------------------------------------------------------------------ */
/* ACL mapping helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Map Notion's permission model to SourceAcl.
 *
 * ACL-mapping decisions (security-critical):
 *
 * 1. If ANY permission is of type "workspace" (Notion's "Workspace access"
 *    or "Full workspace") → public=true, allow=[] (visible to all org members).
 *    This is the only case where public=true is set.
 *
 * 2. If publicUrl=true (the page has a Notion public URL) → public=true.
 *    This means anyone with the link can read, so treat as public.
 *
 * 3. Otherwise: collect only explicit user/group grants. Notion user ids are
 *    mapped to "user:<notionUserId>" and Notion group ids to
 *    "group:<notionGroupId>". These identifiers are opaque strings the
 *    caller can resolve to actual principals via an identity mapping layer.
 *
 * 4. Conservative default: if permissions array is empty and the page is not
 *    workspace-public, allow=[] and public=false (effectively private/orphaned).
 *    This ensures we never accidentally over-share.
 *
 * Invariants (enforced by conformance tests):
 * - Deterministic: same input → same output.
 * - Least-privilege: never grant access not present in the source.
 * - No accidental public: public=true ONLY if workspace or publicUrl is explicit.
 */
export function mapNotionAcl(native: NotionNativePermissions): SourceAcl {
  // Check for public URL sharing (anyone on the internet can access)
  if (native.publicUrl === true) {
    return { allow: [], public: true };
  }

  // Check for workspace-level permission
  const hasWorkspace = native.permissions.some((p) => p.type === "workspace");
  if (hasWorkspace) {
    return { allow: [], public: true };
  }

  // Collect explicit grants (users and groups only)
  const allow: string[] = [];
  for (const p of native.permissions) {
    if (p.type === "user") {
      allow.push(`user:${p.user.id}`);
    } else if (p.type === "group") {
      allow.push(`group:${p.group.id}`);
    }
    // workspace already handled above
  }

  // Deduplicate and sort for determinism
  const uniqueAllow = [...new Set(allow)].sort();
  return { allow: uniqueAllow };
}

/* ------------------------------------------------------------------ */
/* Title extraction                                                     */
/* ------------------------------------------------------------------ */

function extractTitle(page: NotionPageResult): string {
  // Database title at the top-level
  if (page.title && page.title.length > 0) {
    return page.title.map((t) => t.plain_text ?? "").join("") || `${page.object} ${page.id}`;
  }
  // Page title is stored in properties.title or properties.Name
  if (page.properties) {
    for (const key of ["title", "Title", "Name", "name"]) {
      const prop = page.properties[key];
      if (prop && typeof prop === "object") {
        const titleProp = prop as { title?: Array<{ plain_text?: string }> };
        if (titleProp.title && titleProp.title.length > 0) {
          return titleProp.title.map((t) => t.plain_text ?? "").join("") || `Page ${page.id}`;
        }
      }
    }
  }
  return `${page.object} ${page.id}`;
}

/* ------------------------------------------------------------------ */
/* Content extraction (lightweight — full content requires block API)  */
/* ------------------------------------------------------------------ */

function extractContent(page: NotionPageResult): string {
  // For now extract title as a minimal content.
  // A real implementation would fetch /v1/blocks/:id/children for page body.
  // The fixture-based unit tests exercise this path with controlled data.
  const title = extractTitle(page);
  const meta: string[] = [];
  if (page.created_time) meta.push(`Created: ${page.created_time}`);
  if (page.last_edited_time) meta.push(`Last edited: ${page.last_edited_time}`);
  return [title, ...meta].join("\n");
}

/* ------------------------------------------------------------------ */
/* Map a Notion page/database to IngestPayload                         */
/* ------------------------------------------------------------------ */

export function notionPageToIngest(
  page: NotionPageResult,
  orgId: string
): IngestPayload {
  const title = extractTitle(page);
  const content = extractContent(page);

  const source: SourceRef = {
    connector: "notion",
    externalId: page.id,
    url: page.url,
  };

  // Build native permissions for ACL mapping
  const nativePermissions: NotionNativePermissions = {
    permissions: page.permissions ?? [],
    publicUrl: Boolean(page.public_url),
  };
  const sourceAcl = mapNotionAcl(nativePermissions);

  return { orgId, source, title, content, sourceAcl };
}

/* ------------------------------------------------------------------ */
/* NotionConnector                                                      */
/* ------------------------------------------------------------------ */

const NOTION_API_BASE = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2022-06-28";
const NOTION_OAUTH_AUTHORIZE = "https://api.notion.com/v1/oauth/authorize";
const NOTION_OAUTH_TOKEN = "https://api.notion.com/v1/oauth/token";

export class NotionConnector
  implements SourceConnector, OAuthCapable, BackfillCapable, IncrementalCapable, AclCapable
{
  readonly name = "notion";
  private readonly cfg: NotionConnectorConfig;
  private readonly notionVersion: string;

  constructor(cfg: NotionConnectorConfig) {
    this.cfg = cfg;
    this.notionVersion = cfg.notionVersion ?? DEFAULT_NOTION_VERSION;
  }

  /* -- OAuth -- */

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      owner: "user",
      redirect_uri: this.cfg.redirectUri,
      state,
    });
    return `${NOTION_OAUTH_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    fetchFn?: typeof fetch
  ): Promise<TokenRef> {
    const f = fetchFn ?? globalThis.fetch;
    // Basic auth: clientId:clientSecret base64-encoded
    const credentials = Buffer.from(
      `${this.cfg.clientId}:${this.cfg.clientSecret}`
    ).toString("base64");

    const res = await f(NOTION_OAUTH_TOKEN, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
        "Notion-Version": this.notionVersion,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`notion: exchangeCode failed ${res.status}`);
    }
    const data = (await res.json()) as NotionTokenResponse;
    // NEVER log data.access_token
    return {
      accessToken: data.access_token,
      // Notion OAuth does not issue refresh tokens (access is permanent until revoked)
    };
  }

  async refresh(
    _refreshToken: string,
    _fetchFn?: typeof fetch
  ): Promise<TokenRef> {
    // Notion does not support token refresh — tokens are permanent until revoked.
    // Callers should treat expiry as "re-authorize".
    throw new Error("notion: token refresh not supported; re-authorize via OAuth");
  }

  /* -- ACL mapping -- */

  mapAcl(nativePermissions: NativePermissions): SourceAcl {
    return mapNotionAcl(nativePermissions as unknown as NotionNativePermissions);
  }

  /* -- Backfill -- */

  async *backfill(ctx: SyncContext): AsyncGenerator<IngestPayload> {
    yield* this.#search(ctx, undefined);
  }

  /* -- Incremental -- */

  async *incremental(ctx: SyncContext, since: string): AsyncGenerator<IngestPayload> {
    yield* this.#search(ctx, since);
  }

  /* -- Internal: paged search -- */

  async *#search(
    ctx: SyncContext,
    since: string | undefined
  ): AsyncGenerator<IngestPayload> {
    const f = ctx.fetch ?? globalThis.fetch;
    let cursor: string | null = null;

    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: { value: "page", property: "object" },
      };
      if (since) {
        // Notion search doesn't support a filter on last_edited_time in the
        // official search endpoint; we filter client-side below.
      }
      if (cursor) body["start_cursor"] = cursor;

      const res = await f(`${NOTION_API_BASE}/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          "Content-Type": "application/json",
          "Notion-Version": this.notionVersion,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`notion: search failed ${res.status}`);
      }

      const data = (await res.json()) as NotionSearchResponse;

      for (const page of data.results) {
        if (page.archived) continue;

        // Incremental filter: skip pages not edited after `since`
        if (since && page.last_edited_time && page.last_edited_time <= since) {
          continue;
        }

        yield notionPageToIngest(page, ctx.orgId);
      }

      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor !== null);
  }
}
