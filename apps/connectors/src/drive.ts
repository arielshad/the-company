/**
 * GoogleDriveConnector (T4.x)
 *
 * Read-only OAuth connector for Google Drive.
 * - auth-code OAuth against Google (https://accounts.google.com/o/oauth2/v2/auth)
 *   with scope https://www.googleapis.com/auth/drive.readonly
 * - token exchange/refresh against https://oauth2.googleapis.com/token
 * - backfill via GET /drive/v3/files (pageToken pagination)
 * - incremental via the same listing filtered by modifiedTime > since
 * - Google Docs are exported as text/plain via /drive/v3/files/:id/export
 * - mapAcl: conservative mapping of Drive's permissions[] to SourceAcl
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
/* Google Drive-specific config (injected, never logged)               */
/* ------------------------------------------------------------------ */

export interface GoogleDriveConnectorConfig {
  /** OAuth client id */
  clientId: string;
  /** OAuth client secret — never log */
  clientSecret: string;
  /** e.g. https://yourapp.example/api/connectors/google_drive/callback */
  redirectUri: string;
  /** Override the OAuth scope; defaults to drive.readonly */
  scope?: string;
}

/* ------------------------------------------------------------------ */
/* Google Drive API response shapes (minimal, for parsing)             */
/* ------------------------------------------------------------------ */

/**
 * A Drive permission object (from a file's `permissions` field).
 * @see https://developers.google.com/drive/api/reference/rest/v3/permissions
 */
export interface DrivePermission {
  /** "user" | "group" | "domain" | "anyone" */
  type: string;
  /** Present for type "user"/"group". */
  emailAddress?: string;
  /** Present for type "domain". */
  domain?: string;
  /** "owner" | "writer" | "commenter" | "reader" | ... */
  role?: string;
  id?: string;
}

/** Google Drive "native permissions" object passed to mapAcl. */
export interface GoogleDriveNativePermissions extends Record<string, unknown> {
  /** The permissions array from the Drive file's `permissions` field. */
  permissions?: DrivePermission[];
}

/** A Drive file resource (subset of the fields we request). */
export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  /** ISO-8601 */
  modifiedTime?: string;
  permissions?: DrivePermission[];
  webViewLink?: string;
  /** True when the file is in the trash. */
  trashed?: boolean;
}

/** Google Drive files.list response. */
interface DriveFilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

/** Google OAuth token response. */
interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/* ------------------------------------------------------------------ */
/* ACL mapping helpers                                                  */
/* ------------------------------------------------------------------ */

/** Google Docs editor mime type (exported as text instead of downloaded raw). */
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/**
 * Map Google Drive's permission model to SourceAcl.
 *
 * ACL-mapping decisions (security-critical):
 *
 * 1. If ANY permission is of type "anyone" → public=true, allow=[].
 *    "anyone" means anyone with the link / on the web can read — treat as public.
 *    This is the only case where public=true is set.
 *
 * 2. type "domain" with a `domain` field → allow "domain:<domain>".
 *    Visible to everyone in that Google Workspace domain (not the public web).
 *
 * 3. type "user" with an `emailAddress` → allow "user:<emailAddress>".
 *
 * 4. type "group" with an `emailAddress` → allow "group:<emailAddress>".
 *
 * 5. Conservative defaults — when in doubt, DENY (never accidentally public):
 *    - permissions absent or empty → { allow: [] } (private/orphaned).
 *    - a permission missing its identifying field (user/group without
 *      emailAddress, domain without domain) is SKIPPED, not widened.
 *    - unknown permission types are SKIPPED.
 *
 * Invariants (enforced by conformance tests):
 * - Deterministic: same input → same output (allow[] deduped + sorted).
 * - Least-privilege: never grant access not present in the source.
 * - No accidental public: public=true ONLY for an explicit "anyone" permission.
 */
export function mapGoogleDriveAcl(native: GoogleDriveNativePermissions): SourceAcl {
  const permissions = native.permissions;

  // Conservative default: no permissions known → deny (private/orphaned).
  if (!permissions || permissions.length === 0) {
    return { allow: [] };
  }

  // "anyone" → public to the whole web; this is the only public=true case.
  const hasAnyone = permissions.some((p) => p.type === "anyone");
  if (hasAnyone) {
    return { allow: [], public: true };
  }

  const allow: string[] = [];
  for (const p of permissions) {
    switch (p.type) {
      case "domain":
        // Skip if the domain is missing — do not widen access.
        if (p.domain) allow.push(`domain:${p.domain}`);
        break;
      case "user":
        if (p.emailAddress) allow.push(`user:${p.emailAddress}`);
        break;
      case "group":
        if (p.emailAddress) allow.push(`group:${p.emailAddress}`);
        break;
      default:
        // Unknown type → skip (conservative deny).
        break;
    }
  }

  // Deduplicate and sort for determinism.
  const uniqueAllow = [...new Set(allow)].sort();
  return { allow: uniqueAllow };
}

/* ------------------------------------------------------------------ */
/* Title + content extraction                                          */
/* ------------------------------------------------------------------ */

function extractTitle(file: DriveFile): string {
  return file.name && file.name.length > 0 ? file.name : `file ${file.id}`;
}

/**
 * Lightweight content for the metadata-only path (non-Google-Doc files, or
 * when no exported body is supplied). A real sync exports Google Docs as text
 * via driveFileToIngest's `exportedText` argument.
 */
function metadataContent(file: DriveFile): string {
  const title = extractTitle(file);
  const meta: string[] = [];
  if (file.mimeType) meta.push(`Type: ${file.mimeType}`);
  if (file.modifiedTime) meta.push(`Modified: ${file.modifiedTime}`);
  return [title, ...meta].join("\n");
}

/* ------------------------------------------------------------------ */
/* Map a Drive file to IngestPayload                                   */
/* ------------------------------------------------------------------ */

/**
 * Build an IngestPayload from a Drive file.
 * @param exportedText  Optional already-exported document body (Google Docs
 *                       are exported as text/plain); when omitted, a metadata
 *                       summary is used as content.
 */
export function driveFileToIngest(
  file: DriveFile,
  orgId: string,
  exportedText?: string
): IngestPayload {
  const title = extractTitle(file);
  const content =
    exportedText !== undefined && exportedText.length > 0
      ? exportedText
      : metadataContent(file);

  const source: SourceRef = {
    connector: "google_drive",
    externalId: file.id,
    url: file.webViewLink,
  };

  const nativePermissions: GoogleDriveNativePermissions = {
    permissions: file.permissions ?? [],
  };
  const sourceAcl = mapGoogleDriveAcl(nativePermissions);

  return { orgId, source, title, content, sourceAcl };
}

/* ------------------------------------------------------------------ */
/* GoogleDriveConnector                                                 */
/* ------------------------------------------------------------------ */

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,permissions,webViewLink,trashed";

export class GoogleDriveConnector
  implements SourceConnector, OAuthCapable, BackfillCapable, IncrementalCapable, AclCapable
{
  readonly name = "google_drive";
  private readonly cfg: GoogleDriveConnectorConfig;
  private readonly scope: string;

  constructor(cfg: GoogleDriveConnectorConfig) {
    this.cfg = cfg;
    this.scope = cfg.scope ?? DEFAULT_SCOPE;
  }

  /* -- OAuth -- */

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.cfg.redirectUri,
      scope: this.scope,
      // Required to receive a refresh_token from Google.
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${GOOGLE_OAUTH_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    fetchFn?: typeof fetch
  ): Promise<TokenRef> {
    const f = fetchFn ?? globalThis.fetch;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: redirectUri,
    });

    const res = await f(GOOGLE_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`google_drive: exchangeCode failed ${res.status}`);
    }
    const data = (await res.json()) as GoogleTokenResponse;
    // NEVER log data.access_token / data.refresh_token
    return this.#toTokenRef(data);
  }

  async refresh(refreshToken: string, fetchFn?: typeof fetch): Promise<TokenRef> {
    const f = fetchFn ?? globalThis.fetch;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });

    const res = await f(GOOGLE_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`google_drive: refresh failed ${res.status}`);
    }
    const data = (await res.json()) as GoogleTokenResponse;
    // NEVER log tokens. Google does not always reissue a refresh_token on
    // refresh — preserve the caller's existing one when absent.
    const tokenRef = this.#toTokenRef(data);
    if (!tokenRef.refreshToken) tokenRef.refreshToken = refreshToken;
    return tokenRef;
  }

  #toTokenRef(data: GoogleTokenResponse): TokenRef {
    const tokenRef: TokenRef = { accessToken: data.access_token };
    if (data.refresh_token) tokenRef.refreshToken = data.refresh_token;
    if (typeof data.expires_in === "number") {
      tokenRef.expiresAt = Date.now() + data.expires_in * 1000;
    }
    if (data.scope) tokenRef.scope = data.scope;
    return tokenRef;
  }

  /* -- ACL mapping -- */

  mapAcl(nativePermissions: NativePermissions): SourceAcl {
    return mapGoogleDriveAcl(
      nativePermissions as unknown as GoogleDriveNativePermissions
    );
  }

  /* -- Backfill -- */

  async *backfill(ctx: SyncContext): AsyncGenerator<IngestPayload> {
    yield* this.#listFiles(ctx, undefined);
  }

  /* -- Incremental -- */

  async *incremental(ctx: SyncContext, since: string): AsyncGenerator<IngestPayload> {
    yield* this.#listFiles(ctx, since);
  }

  /* -- Internal: paged file listing -- */

  async *#listFiles(
    ctx: SyncContext,
    since: string | undefined
  ): AsyncGenerator<IngestPayload> {
    const f = ctx.fetch ?? globalThis.fetch;
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        pageSize: "100",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      });
      // Exclude trashed files at the source; double-guarded client-side below.
      // For incremental, also bound by modifiedTime on the server.
      const qParts = ["trashed = false"];
      if (since) qParts.push(`modifiedTime > '${since}'`);
      params.set("q", qParts.join(" and "));
      if (pageToken) params.set("pageToken", pageToken);

      const res = await f(`${DRIVE_API_BASE}/files?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
      });

      if (!res.ok) {
        throw new Error(`google_drive: files.list failed ${res.status}`);
      }

      const data = (await res.json()) as DriveFilesListResponse;
      const files = data.files ?? [];

      for (const file of files) {
        // Skip trashed files (client-side guard).
        if (file.trashed) continue;

        // Incremental filter: skip files not modified after `since`.
        if (since && file.modifiedTime && file.modifiedTime <= since) {
          continue;
        }

        // Google Docs have no downloadable bytes; export them as text.
        let exportedText: string | undefined;
        if (file.mimeType === GOOGLE_DOC_MIME) {
          exportedText = await this.#exportDocText(ctx, file.id);
        }

        yield driveFileToIngest(file, ctx.orgId, exportedText);
      }

      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  /** Export a Google Doc as text/plain. Returns "" on failure (metadata used). */
  async #exportDocText(ctx: SyncContext, fileId: string): Promise<string> {
    const f = ctx.fetch ?? globalThis.fetch;
    const params = new URLSearchParams({ mimeType: "text/plain" });
    const res = await f(
      `${DRIVE_API_BASE}/files/${fileId}/export?${params.toString()}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
      }
    );
    if (!res.ok) {
      throw new Error(`google_drive: export failed ${res.status}`);
    }
    return res.text();
  }
}
