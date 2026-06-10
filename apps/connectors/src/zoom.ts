/**
 * ZoomConnector v2 (T4.4)
 *
 * Upgrades the existing ZoomConnector with real webhook verification and
 * transcript fetch. Back-compat: the synchronous handle() method from the
 * original v1 is preserved (used by ConnectorRegistry and existing tests).
 *
 * New surface:
 * - verifyWebhook: Zoom HMAC-SHA256 signature check
 * - fetchAndIngest: fetch real transcript from Zoom download URL, clean, ingest
 * - mapAcl: conservative — meeting participants → explicit allow[], not public
 *
 * Design: secrets/tokens injected; fetch injected; no network in tests.
 * Token/secret logging is explicitly prohibited.
 */

import type { SourceRef } from "@companyos/schemas";
import type {
  SourceConnector,
  IngestPayload,
  TriggerEvent,
  ConnectorResult,
  SourceAcl,
  NativePermissions,
  AclCapable,
  WebhookCapable,
  WebhookContext,
} from "./sdk.js";
import { hmacSha256Hex, safeCompare } from "./sdk.js";

/** Clean a raw VTT/transcript: strip empty lines and leading/trailing whitespace. */
function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Zoom webhook payload shapes                                          */
/* ------------------------------------------------------------------ */

/** The payload Zoom sends for recording.transcript_completed events. */
export interface ZoomWebhookPayload {
  event: string;
  payload: {
    object: {
      id: string;          // meeting id (numeric string)
      uuid: string;        // meeting UUID
      topic?: string;
      start_time?: string; // ISO-8601
      host_id?: string;
      recording_files?: ZoomRecordingFile[];
    };
  };
  download_token?: string; // temporary download JWT (Zoom v2)
}

export interface ZoomRecordingFile {
  id: string;
  recording_type: string;      // "audio_transcript" | "shared_screen_with_speaker_view" | ...
  download_url?: string;
  file_extension?: string;     // "VTT" | "MP4" | ...
  status?: string;
  play_url?: string;
}

/** Native ACL inputs for a Zoom meeting. */
export interface ZoomNativePermissions extends Record<string, unknown> {
  /** Zoom participant email addresses or ids (may be empty for external guests). */
  participantEmails?: string[];
  /** Whether the recording is a public link (Zoom Public Recording). */
  publicRecording?: boolean;
}

/* ------------------------------------------------------------------ */
/* ACL mapping decisions for Zoom                                       */
/* ------------------------------------------------------------------ */

/**
 * Map Zoom meeting permissions to SourceAcl.
 *
 * ACL-mapping decisions (security-critical):
 *
 * 1. If publicRecording=true (Zoom "Public Recording" link) → public=true.
 *    This is the only case where public=true is emitted.
 *
 * 2. Otherwise: we map known participant emails to "user:<email>" principals.
 *    An empty participants list means we could not determine who attended.
 *    We do NOT default to public in that case: allow=[] (private/orphaned).
 *    This is deliberately conservative — it is safer to under-share and
 *    require an admin to broaden access than to accidentally expose a recording.
 *
 * 3. Note: Zoom does not provide a "workspace audience" flag; the old v1
 *    connector used public=true as a placeholder. The v2 mapping is more
 *    conservative: only add participants who are explicitly listed.
 *
 * Invariants: deterministic, least-privilege, no accidental public.
 */
export function mapZoomAcl(native: ZoomNativePermissions): SourceAcl {
  if (native.publicRecording === true) {
    return { allow: [], public: true };
  }
  const emails = native.participantEmails ?? [];
  const allow = [...new Set(emails.map((e) => `user:${e}`))].sort();
  return { allow };
}

/* ------------------------------------------------------------------ */
/* Zoom webhook signature verification                                  */
/* ------------------------------------------------------------------ */

/**
 * Verify a Zoom webhook signature.
 *
 * Zoom signs webhooks with HMAC-SHA256:
 *   message = "v0:" + timestamp + ":" + rawBody
 *   signature header = "v0=" + HMAC-SHA256(webhookSecretToken, message)
 *
 * Headers checked:
 *   x-zm-signature       e.g. "v0=abc123..."
 *   x-zm-request-timestamp  Unix timestamp as string
 */
export function verifyZoomWebhook(
  headers: Record<string, string>,
  rawBody: string,
  ctx: WebhookContext
): boolean {
  // Case-insensitive header lookup
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  const signature = lower["x-zm-signature"];
  const timestamp = lower["x-zm-request-timestamp"];

  if (!signature || !timestamp) return false;

  // Replay protection: reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 300) return false;

  const message = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${hmacSha256Hex(ctx.secret, message)}`;

  return safeCompare(signature, expected);
}

/* ------------------------------------------------------------------ */
/* ZoomConnector v2                                                     */
/* ------------------------------------------------------------------ */

export class ZoomConnector implements SourceConnector, AclCapable, WebhookCapable {
  readonly name = "zoom";

  /* -- Back-compat: synchronous handle() from v1 -- */

  /**
   * Parse a raw webhook/poll transcript payload into ConnectorResult.
   * Kept for back-compat with ConnectorRegistry.handle() and existing tests.
   * The raw payload should be the ZoomTranscriptRaw shape from v1 or a
   * ZoomWebhookPayload; we try both.
   */
  handle(orgId: string, raw: unknown): ConnectorResult {
    // Try v1 shape first (direct transcript payload)
    const r = raw as Record<string, unknown>;
    if (r?.meetingId && r?.transcript) {
      return this.#handleV1(orgId, r);
    }
    // Try v2 Zoom webhook shape
    const maybeWebhook = raw as unknown as ZoomWebhookPayload;
    if (maybeWebhook?.event && maybeWebhook?.payload) {
      return this.#handleWebhookPayload(orgId, maybeWebhook);
    }
    throw new Error("zoom: invalid transcript payload");
  }

  /** Handle the legacy v1 payload shape. */
  #handleV1(orgId: string, r: Record<string, unknown>): ConnectorResult {
    const meetingId = String(r["meetingId"] ?? "");
    const transcript = String(r["transcript"] ?? "");
    const topic = String(r["topic"] ?? `Meeting ${meetingId}`);
    const participants = Array.isArray(r["participants"])
      ? (r["participants"] as string[])
      : [];

    if (!meetingId || !transcript) throw new Error("zoom: invalid transcript payload");

    const source: SourceRef = {
      connector: "zoom",
      externalId: meetingId,
      url: `https://zoom.example/rec/${meetingId}`,
    };

    return {
      ingest: {
        orgId,
        source,
        title: topic,
        content: cleanTranscript(transcript),
        // v1 back-compat: keep the existing behaviour (public=true for org-visible)
        sourceAcl: { allow: [], public: true },
      },
      trigger: {
        kind: "zoom_transcript",
        orgId,
        data: { meetingId, topic, participants, transcript },
      },
    };
  }

  /** Handle a real Zoom webhook payload (v2 shape). */
  #handleWebhookPayload(orgId: string, payload: ZoomWebhookPayload): ConnectorResult {
    const obj = payload.payload?.object;
    if (!obj?.id) throw new Error("zoom: invalid webhook payload — missing meeting id");

    const meetingId = obj.id;
    const topic = obj.topic ?? `Meeting ${meetingId}`;
    const startTime = obj.start_time;
    const recordingFiles = obj.recording_files ?? [];

    // Find transcript file
    const transcriptFile = recordingFiles.find(
      (f) => f.recording_type === "audio_transcript" || f.file_extension === "VTT"
    );

    const source: SourceRef = {
      connector: "zoom",
      externalId: obj.uuid ?? meetingId,
      url: transcriptFile?.play_url ?? `https://zoom.us/recording/${meetingId}`,
    };

    return {
      ingest: {
        orgId,
        source,
        title: topic,
        content: `Zoom recording transcript: ${topic}${startTime ? ` (${startTime})` : ""}`,
        // Conservative: no participants known yet; use fetchAndIngest for real transcript
        sourceAcl: { allow: [] },
      },
      trigger: {
        kind: "zoom_transcript",
        orgId,
        data: {
          meetingId,
          uuid: obj.uuid ?? meetingId,
          topic,
          startTime: startTime ?? null,
          downloadUrl: transcriptFile?.download_url ?? null,
          downloadToken: payload.download_token ?? null,
        },
      },
    };
  }

  /* -- Webhook verification -- */

  verifyWebhook(
    headers: Record<string, string>,
    rawBody: string,
    ctx: WebhookContext
  ): boolean {
    return verifyZoomWebhook(headers, rawBody, ctx);
  }

  /* -- ACL mapping -- */

  mapAcl(nativePermissions: NativePermissions): SourceAcl {
    return mapZoomAcl(nativePermissions as unknown as ZoomNativePermissions);
  }

  /* -- Real transcript fetch + ingest (T4.4) -- */

  /**
   * Fetch a real transcript from Zoom and produce IngestPayload + TriggerEvent.
   *
   * @param orgId         The org this meeting belongs to.
   * @param payload       The parsed Zoom webhook payload.
   * @param participantEmails  Known participant emails for ACL (optional).
   * @param fetchFn       Injected fetch implementation (defaults to globalThis.fetch).
   */
  async fetchAndIngest(
    orgId: string,
    payload: ZoomWebhookPayload,
    participantEmails: string[] = [],
    fetchFn?: typeof fetch
  ): Promise<ConnectorResult> {
    const f = fetchFn ?? globalThis.fetch;
    const obj = payload.payload?.object;
    if (!obj?.id) throw new Error("zoom: invalid webhook payload — missing meeting id");

    const meetingId = obj.id;
    const topic = obj.topic ?? `Meeting ${meetingId}`;
    const recordingFiles = obj.recording_files ?? [];

    // Find the VTT transcript file
    const transcriptFile = recordingFiles.find(
      (f) => f.recording_type === "audio_transcript" || f.file_extension === "VTT"
    );

    if (!transcriptFile?.download_url) {
      throw new Error(`zoom: no transcript download URL for meeting ${meetingId}`);
    }

    // Fetch the transcript content (Bearer download_token if provided)
    const headers: Record<string, string> = {};
    if (payload.download_token) {
      headers["Authorization"] = `Bearer ${payload.download_token}`;
    }

    const res = await f(transcriptFile.download_url, { headers });
    if (!res.ok) {
      throw new Error(`zoom: transcript download failed ${res.status}`);
    }
    const rawTranscript = await res.text();
    const cleanedTranscript = cleanTranscript(rawTranscript);

    const source: SourceRef = {
      connector: "zoom",
      externalId: obj.uuid ?? meetingId,
      url: transcriptFile.play_url ?? `https://zoom.us/recording/${meetingId}`,
    };

    const sourceAcl = mapZoomAcl({ participantEmails });

    return {
      ingest: {
        orgId,
        source,
        title: topic,
        content: cleanedTranscript,
        sourceAcl,
      },
      trigger: {
        kind: "zoom_transcript",
        orgId,
        data: {
          meetingId,
          uuid: obj.uuid ?? meetingId,
          topic,
          startTime: obj.start_time ?? null,
          participants: participantEmails,
          transcript: cleanedTranscript,
        },
      },
    };
  }
}
