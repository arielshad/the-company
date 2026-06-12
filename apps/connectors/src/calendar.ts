/**
 * GoogleCalendarConnector (T4.x)
 *
 * Read-only OAuth connector for Google Calendar.
 * - auth-code OAuth2 against https://accounts.google.com/o/oauth2/v2/auth
 *   + token exchange/refresh at https://oauth2.googleapis.com/token
 *   (scope: https://www.googleapis.com/auth/calendar.readonly)
 * - backfill via GET /calendar/v3/calendars/primary/events (singleEvents=true)
 * - incremental via the updatedMin query parameter
 * - mapAcl: conservative mapping of an event's attendee/organizer set to SourceAcl
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
/* Google Calendar config (injected, never logged)                     */
/* ------------------------------------------------------------------ */

export interface GoogleCalendarConnectorConfig {
  /** OAuth client id */
  clientId: string;
  /** OAuth client secret — never log */
  clientSecret: string;
  /** e.g. https://yourapp.example/api/connectors/google_calendar/callback */
  redirectUri: string;
  /** Calendar id to sync; defaults to "primary". */
  calendarId?: string;
}

/* ------------------------------------------------------------------ */
/* Google Calendar API response shapes (minimal, for parsing)          */
/* ------------------------------------------------------------------ */

/** An attendee of a calendar event. */
export interface GoogleCalendarAttendee {
  /** Attendee email. May be absent for some resource entries. */
  email?: string;
  displayName?: string;
  /** True when the attendee is the organizer. */
  organizer?: boolean;
  /** True when the attendee is a meeting room / resource, not a person. */
  resource?: boolean;
  /** "needsAction" | "declined" | "tentative" | "accepted" */
  responseStatus?: string;
  /** True when this is a placeholder for the requesting user (no real email). */
  self?: boolean;
}

/** The organizer of a calendar event. */
export interface GoogleCalendarOrganizer {
  email?: string;
  displayName?: string;
  self?: boolean;
}

/** Start/end time of an event (dateTime for timed, date for all-day). */
export interface GoogleCalendarEventDate {
  /** RFC3339 timestamp for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD for all-day events. */
  date?: string;
  timeZone?: string;
}

/** A Google Calendar event resource. */
export interface GoogleCalendarEvent {
  kind?: string;
  id: string;
  /** "confirmed" | "tentative" | "cancelled" — cancelled is the trashed analog. */
  status?: string;
  /** Link to the event in the Google Calendar UI. */
  htmlLink?: string;
  /** RFC3339 — when the event was last modified (used by incremental). */
  updated?: string;
  created?: string;
  summary?: string;
  description?: string;
  location?: string;
  /**
   * Event visibility: "default" | "public" | "private" | "confidential".
   * Only "public" maps to SourceAcl.public=true.
   */
  visibility?: string;
  organizer?: GoogleCalendarOrganizer;
  attendees?: GoogleCalendarAttendee[];
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
}

/** Google Calendar events.list API response. */
interface GoogleCalendarEventsResponse {
  kind?: string;
  items?: GoogleCalendarEvent[];
  /** Page token for the next page; absent on the last page. */
  nextPageToken?: string;
  /** Sync token for future incremental syncs (not used here). */
  nextSyncToken?: string;
}

/** Google OAuth2 token response. */
interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

/**
 * Native permissions object for an event, passed to mapAcl.
 * Carries only the fields that affect visibility — derived from the event.
 */
export interface GoogleCalendarNativePermissions extends Record<string, unknown> {
  /** Event visibility string from the Calendar API. */
  visibility?: string;
  /** The event organizer. */
  organizer?: GoogleCalendarOrganizer;
  /** The event attendee list. */
  attendees?: GoogleCalendarAttendee[];
}

/* ------------------------------------------------------------------ */
/* ACL mapping helpers                                                  */
/* ------------------------------------------------------------------ */

/** Loose email sanity check — conservative: anything questionable is dropped. */
function looksLikeEmail(value: string): boolean {
  // Exactly one "@", non-empty local and domain parts, a dot in the domain,
  // and no whitespace. Deliberately strict so we never invent a principal.
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  return true;
}

/**
 * Map a Google Calendar event's visibility + participant set to SourceAcl.
 *
 * ACL-mapping decisions (security-critical):
 *
 * 1. If visibility === "public" → public=true, allow=[]. This is the ONLY
 *    case where public=true is set. Any other visibility value
 *    ("default", "private", "confidential", undefined) is NOT public.
 *
 * 2. Otherwise: an event is visible to its organizer + all human attendees.
 *    Each is mapped to "user:<email>" (lowercased, trimmed). Entries without
 *    a valid email, and resource attendees (meeting rooms / equipment), are
 *    dropped — we never invent a principal we cannot resolve.
 *
 * 3. Conservative default: if there is no organizer email and no attendee
 *    emails, allow=[] and public=false (private to nobody we can name).
 *    When in doubt, DENY — never accidentally public.
 *
 * Invariants (enforced by conformance tests):
 * - Deterministic: same input → same output (deduped + sorted).
 * - Least-privilege: never grant access not present in the source.
 * - No accidental public: public=true ONLY if visibility is explicitly "public".
 */
export function mapGoogleCalendarAcl(
  native: GoogleCalendarNativePermissions
): SourceAcl {
  // Only an explicit "public" visibility makes an event org-public.
  if (native.visibility === "public") {
    return { allow: [], public: true };
  }

  const allow: string[] = [];

  const addEmail = (email: string | undefined): void => {
    if (typeof email !== "string") return;
    const normalized = email.trim().toLowerCase();
    if (normalized.length === 0) return;
    if (!looksLikeEmail(normalized)) return;
    allow.push(`user:${normalized}`);
  };

  // Organizer is always a viewer (when we can name them).
  if (native.organizer) {
    addEmail(native.organizer.email);
  }

  // Each human attendee is a viewer. Skip resource attendees (rooms/equipment).
  for (const attendee of native.attendees ?? []) {
    if (attendee.resource === true) continue;
    addEmail(attendee.email);
  }

  // Deduplicate and sort for determinism.
  const uniqueAllow = [...new Set(allow)].sort();
  return { allow: uniqueAllow };
}

/* ------------------------------------------------------------------ */
/* Title + content extraction                                           */
/* ------------------------------------------------------------------ */

function extractTitle(event: GoogleCalendarEvent): string {
  const summary = event.summary?.trim();
  if (summary && summary.length > 0) return summary;
  return `Event ${event.id}`;
}

function formatEventDate(date: GoogleCalendarEventDate | undefined): string {
  if (!date) return "";
  return date.dateTime ?? date.date ?? "";
}

function extractContent(event: GoogleCalendarEvent): string {
  const lines: string[] = [];

  // Title line.
  lines.push(extractTitle(event));

  // Description (optional).
  const description = event.description?.trim();
  if (description && description.length > 0) {
    lines.push(description);
  }

  // Attendee list (organizer first if present).
  const attendeeLabels: string[] = [];
  const organizerEmail = event.organizer?.email?.trim();
  if (organizerEmail && organizerEmail.length > 0) {
    const name = event.organizer?.displayName?.trim();
    attendeeLabels.push(name ? `${name} <${organizerEmail}> (organizer)` : `${organizerEmail} (organizer)`);
  }
  for (const attendee of event.attendees ?? []) {
    const email = attendee.email?.trim();
    if (!email || email.length === 0) continue;
    // Avoid listing the organizer twice.
    if (organizerEmail && email.toLowerCase() === organizerEmail.toLowerCase()) continue;
    const name = attendee.displayName?.trim();
    attendeeLabels.push(name ? `${name} <${email}>` : email);
  }
  if (attendeeLabels.length > 0) {
    lines.push(`Attendees: ${attendeeLabels.join(", ")}`);
  }

  // Start / end.
  const start = formatEventDate(event.start);
  const end = formatEventDate(event.end);
  if (start || end) {
    lines.push(`Start: ${start}`);
    lines.push(`End: ${end}`);
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Map a Google Calendar event to IngestPayload                        */
/* ------------------------------------------------------------------ */

export function googleCalendarEventToIngest(
  event: GoogleCalendarEvent,
  orgId: string
): IngestPayload {
  const title = extractTitle(event);
  const content = extractContent(event);

  const source: SourceRef = {
    connector: "google_calendar",
    externalId: event.id,
    url: event.htmlLink,
  };

  const nativePermissions: GoogleCalendarNativePermissions = {
    visibility: event.visibility,
    organizer: event.organizer,
    attendees: event.attendees,
  };
  const sourceAcl = mapGoogleCalendarAcl(nativePermissions);

  return { orgId, source, title, content, sourceAcl };
}

/* ------------------------------------------------------------------ */
/* GoogleCalendarConnector                                              */
/* ------------------------------------------------------------------ */

const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const DEFAULT_CALENDAR_ID = "primary";
const PAGE_SIZE = 250; // Google Calendar maxResults cap.

export class GoogleCalendarConnector
  implements SourceConnector, OAuthCapable, BackfillCapable, IncrementalCapable, AclCapable
{
  readonly name = "google_calendar";
  private readonly cfg: GoogleCalendarConnectorConfig;
  private readonly calendarId: string;

  constructor(cfg: GoogleCalendarConnectorConfig) {
    this.cfg = cfg;
    this.calendarId = cfg.calendarId ?? DEFAULT_CALENDAR_ID;
  }

  /* -- OAuth -- */

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.cfg.redirectUri,
      scope: GOOGLE_CALENDAR_SCOPE,
      // offline access + consent prompt so Google issues a refresh token.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
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
      redirect_uri: redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });

    const res = await f(GOOGLE_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`google_calendar: exchangeCode failed ${res.status}`);
    }
    const data = (await res.json()) as GoogleTokenResponse;
    // NEVER log data.access_token / data.refresh_token
    return this.#toTokenRef(data);
  }

  async refresh(
    refreshToken: string,
    fetchFn?: typeof fetch
  ): Promise<TokenRef> {
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
      throw new Error(`google_calendar: refresh failed ${res.status}`);
    }
    const data = (await res.json()) as GoogleTokenResponse;
    // NEVER log data.access_token / data.refresh_token
    // Google may omit refresh_token on refresh — preserve the existing one.
    const ref = this.#toTokenRef(data);
    if (!ref.refreshToken) ref.refreshToken = refreshToken;
    return ref;
  }

  #toTokenRef(data: GoogleTokenResponse): TokenRef {
    const ref: TokenRef = { accessToken: data.access_token };
    if (data.refresh_token) ref.refreshToken = data.refresh_token;
    if (typeof data.expires_in === "number") {
      ref.expiresAt = Date.now() + data.expires_in * 1000;
    }
    if (data.scope) ref.scope = data.scope;
    return ref;
  }

  /* -- ACL mapping -- */

  mapAcl(nativePermissions: NativePermissions): SourceAcl {
    return mapGoogleCalendarAcl(
      nativePermissions as unknown as GoogleCalendarNativePermissions
    );
  }

  /* -- Backfill -- */

  async *backfill(ctx: SyncContext): AsyncGenerator<IngestPayload> {
    yield* this.#listEvents(ctx, undefined);
  }

  /* -- Incremental -- */

  async *incremental(
    ctx: SyncContext,
    since: string
  ): AsyncGenerator<IngestPayload> {
    yield* this.#listEvents(ctx, since);
  }

  /* -- Internal: paged events.list -- */

  async *#listEvents(
    ctx: SyncContext,
    since: string | undefined
  ): AsyncGenerator<IngestPayload> {
    const f = ctx.fetch ?? globalThis.fetch;
    let pageToken: string | undefined = undefined;

    do {
      const params = new URLSearchParams({
        singleEvents: "true",
        maxResults: String(PAGE_SIZE),
        // Stable ordering helps determinism of the first-item conformance check.
        orderBy: "updated",
      });
      if (since) params.set("updatedMin", since);
      if (pageToken) params.set("pageToken", pageToken);

      const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(
        this.calendarId
      )}/events?${params.toString()}`;

      const res = await f(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        throw new Error(`google_calendar: events.list failed ${res.status}`);
      }

      const data = (await res.json()) as GoogleCalendarEventsResponse;

      for (const event of data.items ?? []) {
        // "cancelled" is the Calendar API's trashed/archived analog — skip it.
        if (event.status === "cancelled") continue;

        yield googleCalendarEventToIngest(event, ctx.orgId);
      }

      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken !== undefined);
  }
}
