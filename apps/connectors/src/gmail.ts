/**
 * GmailConnector (T4.x)
 *
 * Read-only OAuth connector for Gmail.
 * - auth-code OAuth2 against Google (https://accounts.google.com / oauth2.googleapis.com)
 * - scope https://www.googleapis.com/auth/gmail.readonly
 * - backfill via GET /gmail/v1/users/me/messages (list), then GET .../messages/{id}
 * - incremental via the same list endpoint with `q=after:<unix-seconds>`
 * - mapAcl: a mailbox is PRIVATE to its owner — allow ["user:<owner-email>"], never public
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
/* Gmail-specific config (injected, never logged)                      */
/* ------------------------------------------------------------------ */

export interface GmailConnectorConfig {
  /** OAuth client id */
  clientId: string;
  /** OAuth client secret — never log */
  clientSecret: string;
  /** e.g. https://yourapp.example/api/connectors/gmail/callback */
  redirectUri: string;
}

/* ------------------------------------------------------------------ */
/* Gmail API response shapes (minimal, for parsing)                    */
/* ------------------------------------------------------------------ */

/** A single header on a message part. */
export interface GmailHeader {
  name: string;
  value: string;
}

/** A message body payload (recursive — multipart messages nest parts). */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    size?: number;
    /** URL-safe base64 (RFC 4648 §5) encoded body data. */
    data?: string;
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
}

/** A full Gmail message (format=full from messages.get). */
export interface GmailMessage {
  id: string;
  threadId?: string;
  /** Label ids such as INBOX, TRASH, SPAM, UNREAD, etc. */
  labelIds?: string[];
  snippet?: string;
  /** Internal receive date as a string of Unix ms. */
  internalDate?: string;
  payload?: GmailMessagePart;
}

/** A stub message from messages.list (id + threadId only). */
interface GmailMessageStub {
  id: string;
  threadId?: string;
}

/** Gmail messages.list response. */
interface GmailListResponse {
  messages?: GmailMessageStub[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** Google OAuth token response. */
interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/**
 * Gmail "native permissions" object passed to mapAcl.
 * A mailbox is owned by exactly one principal; visibility is private to that
 * owner. We carry only the owner's email — there is no sharing model to map.
 */
export interface GmailNativePermissions extends Record<string, unknown> {
  /** Email address of the mailbox owner (the authenticated user). */
  ownerEmail?: string;
}

/* ------------------------------------------------------------------ */
/* ACL mapping helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Map a Gmail mailbox's ownership to SourceAcl.
 *
 * ACL-mapping decisions (security-critical):
 *
 * 1. A Gmail message lives in a single user's mailbox. It is PRIVATE to that
 *    mailbox owner — there is no concept of workspace/group sharing for a
 *    personal inbox. Therefore public is NEVER set to true.
 *
 * 2. When an owner email is present → allow ["user:<owner-email>"].
 *    The email is lowercased and trimmed for determinism.
 *
 * 3. Conservative default: if the owner email is missing/blank/invalid, we
 *    DENY by returning allow=[] (public unset). When in doubt, deny — we must
 *    never accidentally grant a mailbox to the wrong principal or to everyone.
 *
 * Invariants (enforced by conformance tests):
 * - Deterministic: same input → same output.
 * - Least-privilege: only the owner is ever granted access.
 * - No accidental public: public is never true.
 */
export function mapGmailAcl(native: GmailNativePermissions): SourceAcl {
  const raw = typeof native.ownerEmail === "string" ? native.ownerEmail.trim().toLowerCase() : "";

  // Conservative: a blank or syntactically implausible address → deny.
  // We require a single "@" with non-empty local and domain parts.
  const at = raw.indexOf("@");
  const looksLikeEmail =
    raw.length > 0 &&
    at > 0 &&
    at === raw.lastIndexOf("@") &&
    at < raw.length - 1 &&
    !raw.includes(" ");

  if (!looksLikeEmail) {
    return { allow: [] };
  }

  return { allow: [`user:${raw}`] };
}

/* ------------------------------------------------------------------ */
/* Header / title extraction                                            */
/* ------------------------------------------------------------------ */

/** Case-insensitive header lookup over a message's top-level payload. */
function getHeader(msg: GmailMessage, name: string): string | undefined {
  const headers = msg.payload?.headers;
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return undefined;
}

function extractTitle(msg: GmailMessage): string {
  const subject = getHeader(msg, "Subject");
  if (subject && subject.trim().length > 0) return subject;
  return `(no subject) ${msg.id}`;
}

/* ------------------------------------------------------------------ */
/* Body / content extraction                                            */
/* ------------------------------------------------------------------ */

/** Decode URL-safe base64 (Gmail uses RFC 4648 §5 alphabet). */
function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

/**
 * Walk the MIME tree and return the first text/plain body found, falling back
 * to text/html, then to the message snippet. Deterministic depth-first search.
 */
function extractBody(msg: GmailMessage): string {
  const plain = findPartData(msg.payload, "text/plain");
  if (plain !== undefined) return decodeBase64Url(plain);

  const html = findPartData(msg.payload, "text/html");
  if (html !== undefined) return decodeBase64Url(html);

  return msg.snippet ?? "";
}

function findPartData(
  part: GmailMessagePart | undefined,
  mimeType: string
): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPartData(child, mimeType);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Map a Gmail message to IngestPayload                                 */
/* ------------------------------------------------------------------ */

export function gmailMessageToIngest(
  msg: GmailMessage,
  orgId: string,
  ownerEmail?: string
): IngestPayload {
  const title = extractTitle(msg);

  const from = getHeader(msg, "From");
  const date = getHeader(msg, "Date");
  const meta: string[] = [];
  if (from) meta.push(`From: ${from}`);
  if (date) meta.push(`Date: ${date}`);
  const body = extractBody(msg);
  const content = [...meta, "", body].join("\n");

  const source: SourceRef = {
    connector: "gmail",
    externalId: msg.id,
    url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
  };

  // A mailbox is private to its owner; map ownership conservatively.
  const sourceAcl = mapGmailAcl({ ownerEmail });

  return { orgId, source, title, content, sourceAcl };
}

/* ------------------------------------------------------------------ */
/* GmailConnector                                                       */
/* ------------------------------------------------------------------ */

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

/** Labels whose presence means the message is trashed/spam and must be skipped. */
const SKIP_LABELS = new Set(["TRASH", "SPAM"]);

export class GmailConnector
  implements SourceConnector, OAuthCapable, BackfillCapable, IncrementalCapable, AclCapable
{
  readonly name = "gmail";
  private readonly cfg: GmailConnectorConfig;

  constructor(cfg: GmailConnectorConfig) {
    this.cfg = cfg;
  }

  /* -- OAuth -- */

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.cfg.redirectUri,
      scope: GMAIL_SCOPE,
      // offline + consent so Google returns a refresh_token we can store
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
    // Google's token endpoint expects application/x-www-form-urlencoded.
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
      throw new Error(`gmail: exchangeCode failed ${res.status}`);
    }
    const data = (await res.json()) as GoogleTokenResponse;
    // NEVER log data.access_token / data.refresh_token
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    };
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
      throw new Error(`gmail: refresh failed ${res.status}`);
    }
    const data = (await res.json()) as GoogleTokenResponse;
    // NEVER log tokens. Google may not re-issue a refresh_token on refresh;
    // preserve the caller's existing one in that case.
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    };
  }

  /* -- ACL mapping -- */

  mapAcl(nativePermissions: NativePermissions): SourceAcl {
    return mapGmailAcl(nativePermissions as unknown as GmailNativePermissions);
  }

  /* -- Backfill -- */

  async *backfill(ctx: SyncContext): AsyncGenerator<IngestPayload> {
    yield* this.#listMessages(ctx, undefined);
  }

  /* -- Incremental -- */

  async *incremental(ctx: SyncContext, since: string): AsyncGenerator<IngestPayload> {
    yield* this.#listMessages(ctx, since);
  }

  /* -- Internal: resolve mailbox owner email (for ACL) -- */

  async #getOwnerEmail(
    ctx: SyncContext,
    f: typeof globalThis.fetch
  ): Promise<string | undefined> {
    const res = await f(`${GMAIL_API_BASE}/profile`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`gmail: profile failed ${res.status}`);
    }
    const data = (await res.json()) as { emailAddress?: string };
    return data.emailAddress;
  }

  /* -- Internal: paged list + per-message fetch -- */

  async *#listMessages(
    ctx: SyncContext,
    since: string | undefined
  ): AsyncGenerator<IngestPayload> {
    const f = ctx.fetch ?? globalThis.fetch;

    // Resolve the mailbox owner once; it drives the (private) ACL for every
    // message. If we cannot determine it, mapGmailAcl will conservatively deny.
    const ownerEmail = await this.#getOwnerEmail(ctx, f);

    // Build the `q` query for incremental sync. Gmail's `after:` takes a Unix
    // timestamp (seconds). We derive it from the ISO `since`.
    let q: string | undefined;
    if (since) {
      const seconds = Math.floor(new Date(since).getTime() / 1000);
      if (Number.isFinite(seconds)) q = `after:${seconds}`;
    }

    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ maxResults: "100" });
      if (q) params.set("q", q);
      if (pageToken) params.set("pageToken", pageToken);

      const listRes = await f(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ctx.accessToken}` },
      });
      if (!listRes.ok) {
        throw new Error(`gmail: messages.list failed ${listRes.status}`);
      }

      const list = (await listRes.json()) as GmailListResponse;
      const stubs = list.messages ?? [];

      for (const stub of stubs) {
        const msg = await this.#getMessage(ctx, f, stub.id);

        // Skip trashed/spam messages (conservative: never ingest deleted mail).
        const labels = msg.labelIds ?? [];
        if (labels.some((l) => SKIP_LABELS.has(l))) continue;

        yield gmailMessageToIngest(msg, ctx.orgId, ownerEmail);
      }

      pageToken = list.nextPageToken;
    } while (pageToken);
  }

  /* -- Internal: fetch a single full message -- */

  async #getMessage(
    ctx: SyncContext,
    f: typeof globalThis.fetch,
    id: string
  ): Promise<GmailMessage> {
    const params = new URLSearchParams({ format: "full" });
    const res = await f(`${GMAIL_API_BASE}/messages/${id}?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`gmail: messages.get failed ${res.status}`);
    }
    return (await res.json()) as GmailMessage;
  }
}
