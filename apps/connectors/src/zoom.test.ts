/**
 * ZoomConnector v2 tests (T4.4)
 *
 * All tests are network-free; fetch is injected where needed.
 * Covers: webhook verification (valid + tampered), fetchAndIngest,
 * ACL mapping, back-compat handle(), and conformance kit.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ZoomConnector,
  mapZoomAcl,
  verifyZoomWebhook,
  type ZoomWebhookPayload,
  type ZoomNativePermissions,
} from "./zoom.js";
import { hmacSha256Hex, runConformance } from "./sdk-node.js";
import { ORG } from "@companyos/testing";

/* ------------------------------------------------------------------ */
/* Helpers to build a valid signed webhook                             */
/* ------------------------------------------------------------------ */

const WEBHOOK_SECRET = "zoom-webhook-secret-token";

function makeZoomSignature(timestamp: string, rawBody: string): string {
  const message = `v0:${timestamp}:${rawBody}`;
  return `v0=${hmacSha256Hex(WEBHOOK_SECRET, message)}`;
}

function makeValidWebhookHeaders(rawBody: string, timestampOverride?: number) {
  const timestamp = String(timestampOverride ?? Math.floor(Date.now() / 1000));
  return {
    "x-zm-signature": makeZoomSignature(timestamp, rawBody),
    "x-zm-request-timestamp": timestamp,
  };
}

/** A minimal Zoom transcript_completed webhook payload. */
const TRANSCRIPT_BODY = JSON.stringify({
  event: "recording.transcript_completed",
  payload: {
    object: {
      id: "meeting-123",
      uuid: "uuid-abc-123",
      topic: "Acme Q3 Review",
      start_time: "2026-06-08T15:00:00Z",
      host_id: "host-1",
      recording_files: [
        {
          id: "file-1",
          recording_type: "audio_transcript",
          download_url: "https://zoom.us/rec/download/transcript.vtt",
          file_extension: "VTT",
          status: "completed",
          play_url: "https://zoom.us/rec/play/uuid-abc-123",
        },
      ],
    },
  },
  download_token: "jwt-download-token-xyz",
});

const TRANSCRIPT_PAYLOAD: ZoomWebhookPayload = JSON.parse(TRANSCRIPT_BODY) as ZoomWebhookPayload;

/* ------------------------------------------------------------------ */
/* verifyZoomWebhook                                                   */
/* ------------------------------------------------------------------ */

describe("verifyZoomWebhook", () => {
  it("accepts a correctly signed webhook", () => {
    const headers = makeValidWebhookHeaders(TRANSCRIPT_BODY);
    const result = verifyZoomWebhook(headers, TRANSCRIPT_BODY, { secret: WEBHOOK_SECRET });
    expect(result).toBe(true);
  });

  it("rejects a tampered body (different body, same signature)", () => {
    const headers = makeValidWebhookHeaders(TRANSCRIPT_BODY);
    const tamperedBody = TRANSCRIPT_BODY + " tampered";
    const result = verifyZoomWebhook(headers, tamperedBody, { secret: WEBHOOK_SECRET });
    expect(result).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const headers = makeValidWebhookHeaders(TRANSCRIPT_BODY);
    const result = verifyZoomWebhook(headers, TRANSCRIPT_BODY, { secret: "wrong-secret" });
    expect(result).toBe(false);
  });

  it("rejects when x-zm-signature header is missing", () => {
    const headers = makeValidWebhookHeaders(TRANSCRIPT_BODY);
    const { "x-zm-signature": _omit, ...noSig } = headers;
    const result = verifyZoomWebhook(noSig, TRANSCRIPT_BODY, { secret: WEBHOOK_SECRET });
    expect(result).toBe(false);
  });

  it("rejects when x-zm-request-timestamp header is missing", () => {
    const headers = makeValidWebhookHeaders(TRANSCRIPT_BODY);
    const { "x-zm-request-timestamp": _omit, ...noTs } = headers;
    const result = verifyZoomWebhook(noTs, TRANSCRIPT_BODY, { secret: WEBHOOK_SECRET });
    expect(result).toBe(false);
  });

  it("rejects a replay (timestamp older than 5 minutes)", () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s > 300s limit
    const headers = makeValidWebhookHeaders(TRANSCRIPT_BODY, oldTimestamp);
    const result = verifyZoomWebhook(headers, TRANSCRIPT_BODY, { secret: WEBHOOK_SECRET });
    expect(result).toBe(false);
  });

  it("uses case-insensitive header keys", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = makeZoomSignature(timestamp, TRANSCRIPT_BODY);
    const uppercaseHeaders = {
      "X-Zm-Signature": sig,
      "X-Zm-Request-Timestamp": timestamp,
    };
    const result = verifyZoomWebhook(uppercaseHeaders, TRANSCRIPT_BODY, { secret: WEBHOOK_SECRET });
    expect(result).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* mapZoomAcl                                                          */
/* ------------------------------------------------------------------ */

describe("mapZoomAcl", () => {
  it("publicRecording=true → public=true, allow=[]", () => {
    const acl = mapZoomAcl({ publicRecording: true });
    expect(acl.public).toBe(true);
    expect(acl.allow).toEqual([]);
  });

  it("participants → allow contains user:<email>", () => {
    const acl = mapZoomAcl({
      participantEmails: ["alice@example.com", "bob@example.com"],
    });
    expect(acl.public).toBeFalsy();
    expect(acl.allow).toContain("user:alice@example.com");
    expect(acl.allow).toContain("user:bob@example.com");
  });

  it("no participants, not public → allow=[], public=false (conservative)", () => {
    const acl = mapZoomAcl({});
    expect(acl.public).toBeFalsy();
    expect(acl.allow).toEqual([]);
  });

  it("deduplicates repeated emails", () => {
    const acl = mapZoomAcl({
      participantEmails: ["alice@example.com", "alice@example.com"],
    });
    expect(acl.allow).toEqual(["user:alice@example.com"]);
  });

  it("is deterministic", () => {
    const native: ZoomNativePermissions = {
      participantEmails: ["c@x.com", "a@x.com", "b@x.com"],
    };
    const r1 = mapZoomAcl(native);
    const r2 = mapZoomAcl(native);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    // Also should be sorted
    expect(r1.allow).toEqual(["user:a@x.com", "user:b@x.com", "user:c@x.com"]);
  });
});

/* ------------------------------------------------------------------ */
/* ZoomConnector.handle() back-compat (v1 shape)                      */
/* ------------------------------------------------------------------ */

describe("ZoomConnector v2 — back-compat handle()", () => {
  const connector = new ZoomConnector();

  it("parses v1 payload shape", () => {
    const res = connector.handle(ORG, {
      meetingId: "zoom-123",
      topic: "Q3 Review",
      transcript: "Alice: Hello.\nBob: Hi.",
      participants: ["Alice", "Bob"],
    });
    expect(res.ingest.source.connector).toBe("zoom");
    expect(res.ingest.source.externalId).toBe("zoom-123");
    expect(res.trigger.kind).toBe("zoom_transcript");
  });

  it("throws on invalid payload", () => {
    expect(() => connector.handle(ORG, { foo: "bar" })).toThrow();
  });

  it("also handles v2 webhook payload shape", () => {
    const res = connector.handle(ORG, TRANSCRIPT_PAYLOAD);
    expect(res.trigger.kind).toBe("zoom_transcript");
    expect(res.ingest.source.connector).toBe("zoom");
    expect(res.ingest.source.externalId).toBe("uuid-abc-123");
  });
});

/* ------------------------------------------------------------------ */
/* ZoomConnector.fetchAndIngest — real transcript download (mock)     */
/* ------------------------------------------------------------------ */

describe("ZoomConnector.fetchAndIngest (mock fetch)", () => {
  it("fetches transcript, cleans it, produces ingest payload + trigger", async () => {
    const rawVTT = `
      WEBVTT

      00:00:01.000 --> 00:00:04.000
      Alice: Good morning everyone.

      00:00:05.000 --> 00:00:08.000
      Bob: Let's begin the Q3 review.
    `;

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => rawVTT,
    });

    const connector = new ZoomConnector();
    const result = await connector.fetchAndIngest(
      ORG,
      TRANSCRIPT_PAYLOAD,
      ["alice@example.com", "bob@example.com"],
      mockFetch as unknown as typeof fetch
    );

    expect(result.ingest.source.connector).toBe("zoom");
    expect(result.ingest.source.externalId).toBe("uuid-abc-123");
    expect(result.ingest.title).toBe("Acme Q3 Review");
    expect(result.ingest.content).toContain("Alice:");
    expect(result.ingest.content).toContain("Bob:");
    // Blank lines should be removed by cleanTranscript
    expect(result.ingest.content).not.toMatch(/^\s*$/m);
    // ACL should reflect participants
    expect(result.ingest.sourceAcl?.allow).toContain("user:alice@example.com");
    expect(result.trigger.kind).toBe("zoom_transcript");
    expect(result.trigger.data.transcript).toContain("Alice:");
  });

  it("passes the download_token as Authorization Bearer", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "Alice: Content.",
    });

    const connector = new ZoomConnector();
    await connector.fetchAndIngest(ORG, TRANSCRIPT_PAYLOAD, [], mockFetch as unknown as typeof fetch);

    const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe("Bearer jwt-download-token-xyz");
  });

  it("throws when no download URL found", async () => {
    const noFilesPayload: ZoomWebhookPayload = {
      event: "recording.transcript_completed",
      payload: { object: { id: "meet-1", uuid: "uuid-1", recording_files: [] } },
    };
    const connector = new ZoomConnector();
    await expect(
      connector.fetchAndIngest(ORG, noFilesPayload, [], vi.fn() as unknown as typeof fetch)
    ).rejects.toThrow("no transcript download URL");
  });

  it("throws when download HTTP request fails", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 });
    const connector = new ZoomConnector();
    await expect(
      connector.fetchAndIngest(ORG, TRANSCRIPT_PAYLOAD, [], mockFetch as unknown as typeof fetch)
    ).rejects.toThrow("403");
  });
});

/* ------------------------------------------------------------------ */
/* Conformance kit — ZoomConnector                                     */
/* ------------------------------------------------------------------ */

describe("ConnectorConformance — ZoomConnector", () => {
  it("passes all conformance invariants", async () => {
    const validWebhookHeaders = makeValidWebhookHeaders(TRANSCRIPT_BODY);

    const result = await runConformance(new ZoomConnector(), {
      orgId: ORG,
      aclCases: [
        {
          label: "public recording",
          native: { publicRecording: true } as ZoomNativePermissions,
          expected: { allow: [], public: true },
        },
        {
          label: "known participants",
          native: {
            participantEmails: ["alice@example.com"],
          } as ZoomNativePermissions,
          expected: { allow: ["user:alice@example.com"] },
        },
        {
          label: "no participants (conservative: private)",
          native: {} as ZoomNativePermissions,
          expected: { allow: [] },
        },
      ],
      validWebhook: {
        headers: validWebhookHeaders,
        rawBody: TRANSCRIPT_BODY,
        ctx: { secret: WEBHOOK_SECRET },
      },
      tamperedWebhook: {
        headers: validWebhookHeaders,
        rawBody: TRANSCRIPT_BODY + " tampered",
        ctx: { secret: WEBHOOK_SECRET },
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
