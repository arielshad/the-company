import type { SourceRef } from "@companyos/schemas";
import type { TriggerKind } from "@companyos/dsl";

/** Origin permissions captured at ingest (mirrors @companyos/auth SourceAcl). */
export interface SourceAcl {
  allow: string[];
  public?: boolean;
}

/**
 * Connector SDK (PHASE-06): a uniform contract so every connector ingests with
 * provenance + source ACLs and emits the workflow triggers it owns. The Zoom
 * connector below feeds the flagship scenario.
 */

export interface IngestPayload {
  orgId: string;
  source: SourceRef;
  title: string;
  content: string;
  sourceAcl?: SourceAcl;
}

export interface TriggerEvent {
  kind: TriggerKind;
  orgId: string;
  data: Record<string, unknown>;
}

export interface ConnectorResult {
  ingest: IngestPayload;
  trigger: TriggerEvent;
}

export interface Connector {
  readonly name: string;
  /** Parse an inbound webhook/poll item into an ingest payload + trigger. */
  handle(orgId: string, raw: unknown): ConnectorResult;
}

export interface ConnectorHealth {
  name: string;
  lastSyncAt?: string;
  lastError?: string;
  ok: boolean;
}

interface ZoomTranscriptRaw {
  meetingId: string;
  topic: string;
  startedAt?: string;
  participants?: string[];
  transcript: string;
}

export class ZoomConnector implements Connector {
  readonly name = "zoom";

  handle(orgId: string, raw: unknown): ConnectorResult {
    const r = raw as ZoomTranscriptRaw;
    if (!r?.meetingId || !r?.transcript) throw new Error("zoom: invalid transcript payload");
    const source: SourceRef = {
      connector: "zoom",
      externalId: r.meetingId,
      url: `https://zoom.example/rec/${r.meetingId}`
    };
    return {
      ingest: {
        orgId,
        source,
        title: r.topic ?? `Meeting ${r.meetingId}`,
        content: r.transcript,
        // meetings are visible to org members by default; tighten per policy
        sourceAcl: { allow: [], public: true }
      },
      trigger: {
        kind: "zoom_transcript",
        orgId,
        data: {
          meetingId: r.meetingId,
          topic: r.topic,
          participants: r.participants ?? [],
          transcript: r.transcript
        }
      }
    };
  }
}

/** Registry of connectors with simple health tracking (FR-2.4). */
export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  private health = new Map<string, ConnectorHealth>();

  register(c: Connector): void {
    this.connectors.set(c.name, c);
    this.health.set(c.name, { name: c.name, ok: true });
  }

  handle(name: string, orgId: string, raw: unknown): ConnectorResult {
    const c = this.connectors.get(name);
    if (!c) throw new Error(`connector ${name} not registered`);
    try {
      const res = c.handle(orgId, raw);
      this.health.set(name, { name, ok: true, lastSyncAt: new Date().toISOString() });
      return res;
    } catch (e) {
      this.health.set(name, { name, ok: false, lastError: (e as Error).message, lastSyncAt: new Date().toISOString() });
      throw e;
    }
  }

  healthAll(): ConnectorHealth[] {
    return [...this.health.values()];
  }
}

/** Clean a raw transcript (used by the workflow `tool` node text.clean_transcript). */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Re-exports from SDK v2 and new connectors (T4.1, T4.2, T4.4, T4.5) */
/* ------------------------------------------------------------------ */

// SDK v2 — types, HMAC utils, and conformance kit
export type {
  SourceConnector,
  TokenRef,
  OAuthCapable,
  BackfillCapable,
  IncrementalCapable,
  AclCapable,
  WebhookCapable,
  WebhookContext,
  SyncContext,
  NativePermissions,
  ConformanceFixtures,
  ConformanceResult,
} from "./sdk.js";
export { hmacSha256Hex, safeCompare, runConformance } from "./sdk.js";

// Notion connector (T4.2)
export type {
  NotionConnectorConfig,
  NotionNativePermissions,
  NotionPermission,
  NotionPageResult,
} from "./notion.js";
export { NotionConnector, notionPageToIngest, mapNotionAcl } from "./notion.js";

// Zoom connector v2 (T4.4)
export type {
  ZoomWebhookPayload,
  ZoomRecordingFile,
  ZoomNativePermissions,
} from "./zoom.js";
export {
  ZoomConnector as ZoomConnectorV2,
  mapZoomAcl,
  verifyZoomWebhook,
} from "./zoom.js";

// Slack outbound notifier (T4.5)
export type { PostMessageParams, PostMessageResult } from "./slack.js";
export { SlackNotifier } from "./slack.js";
