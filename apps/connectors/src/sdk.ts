/**
 * Connector SDK v2 (T4.1)
 *
 * Composable types for the async connector lifecycle:
 *   OAuth  →  backfill  →  incremental  →  webhook verify
 *
 * Design principles:
 * - Every method is optional: connectors implement only what they support.
 * - Tokens/secrets are ALWAYS injected by the caller; they are NEVER logged.
 * - mapAcl is the security core: least-privilege, no accidental public.
 * - ConnectorConformance is the testable contract every connector must pass.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SourceRef } from "@companyos/schemas";
import type { TriggerKind } from "@companyos/dsl";

/* ------------------------------------------------------------------ */
/* Core value types (re-exported so callers need only the SDK)         */
/* ------------------------------------------------------------------ */

export interface SourceAcl {
  /** Identity/group strings that may see the object, e.g. "user:alice", "group:eng". */
  allow: string[];
  /** True only when the source explicitly publishes to the entire org workspace. */
  public?: boolean;
}

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

/* ------------------------------------------------------------------ */
/* Context objects passed at runtime (injected; never stored globally)  */
/* ------------------------------------------------------------------ */

/** Context available during backfill / incremental sync. */
export interface SyncContext {
  orgId: string;
  /** Opaque access token (already refreshed by the caller). */
  accessToken: string;
  /** Optional fetch override; defaults to globalThis.fetch in production. */
  fetch?: typeof globalThis.fetch;
}

/** Context available during webhook verification. */
export interface WebhookContext {
  /** Connector-specific secret (e.g. Zoom webhook secret token). */
  secret: string;
}

/* ------------------------------------------------------------------ */
/* OAuth helpers (T4.1)                                                 */
/* ------------------------------------------------------------------ */

/** Minimal token reference returned after OAuth exchange / refresh. */
export interface TokenRef {
  /** Opaque access token; NEVER log this. */
  accessToken: string;
  /** Opaque refresh token; NEVER log this. */
  refreshToken?: string;
  expiresAt?: number; // Unix ms
  scope?: string;
}

/** OAuth helpers — implemented by connectors that support auth-code flow. */
export interface OAuthCapable {
  /**
   * Build the authorization redirect URL.
   * @param state  CSRF/PKCE state the caller must verify on callback.
   */
  authorizeUrl(state: string): string;

  /**
   * Exchange an auth-code for tokens.
   * @returns TokenRef — log NONE of its fields.
   */
  exchangeCode(code: string, redirectUri: string, fetchFn?: typeof globalThis.fetch): Promise<TokenRef>;

  /**
   * Refresh an existing token.
   * @returns new TokenRef — log NONE of its fields.
   */
  refresh(refreshToken: string, fetchFn?: typeof globalThis.fetch): Promise<TokenRef>;
}

/* ------------------------------------------------------------------ */
/* Sync helpers                                                         */
/* ------------------------------------------------------------------ */

/** Connectors that support bulk backfill. */
export interface BackfillCapable {
  /**
   * Async-generate every IngestPayload reachable from the source.
   * Callers stream this into brain.ingest; restartable via cursor.
   */
  backfill(ctx: SyncContext): AsyncGenerator<IngestPayload>;
}

/** Connectors that support incremental (delta) sync. */
export interface IncrementalCapable {
  /**
   * Like backfill, but bounded to items changed after `since` (ISO-8601).
   */
  incremental(ctx: SyncContext, since: string): AsyncGenerator<IngestPayload>;
}

/* ------------------------------------------------------------------ */
/* ACL mapping — the security core                                      */
/* ------------------------------------------------------------------ */

/**
 * Native permission object returned by the source system.
 * Each connector defines its own subtype; mapAcl converts it to SourceAcl.
 */
export type NativePermissions = Record<string, unknown>;

/** Connectors that can faithfully map source permissions to SourceAcl. */
export interface AclCapable {
  /**
   * Map source-native permissions to SourceAcl.
   *
   * Contract (enforced by conformance tests):
   * 1. Deterministic: identical input → identical output.
   * 2. Least-privilege: never grant access not present in the source.
   * 3. No accidental public: only set public=true if the source EXPLICITLY
   *    shares to the whole workspace/org.
   * 4. Empty allow[] with public=false is valid (object is private/orphaned).
   */
  mapAcl(nativePermissions: NativePermissions): SourceAcl;
}

/* ------------------------------------------------------------------ */
/* Webhook verification                                                 */
/* ------------------------------------------------------------------ */

/** Connectors that receive and verify signed webhooks. */
export interface WebhookCapable {
  /**
   * Return true iff the webhook signature is valid.
   * Must use constant-time comparison to prevent timing attacks.
   * @param headers  HTTP headers (case-insensitive lookup is the caller's job).
   * @param rawBody  Unmodified request body bytes/string.
   * @param ctx      Provides the secret; never log ctx.secret.
   */
  verifyWebhook(
    headers: Record<string, string>,
    rawBody: string,
    ctx: WebhookContext
  ): boolean;
}

/* ------------------------------------------------------------------ */
/* Composite "full" connector interface                                 */
/* ------------------------------------------------------------------ */

/**
 * SourceConnector is the superset; not every connector implements every method.
 * Use `implements Partial<SourceConnector>` and duck-type the optional parts.
 */
export interface SourceConnector
  extends Partial<OAuthCapable>,
    Partial<BackfillCapable>,
    Partial<IncrementalCapable>,
    Partial<AclCapable>,
    Partial<WebhookCapable> {
  readonly name: string;
}

/* ------------------------------------------------------------------ */
/* HMAC utility — shared by Zoom, Slack, etc.                          */
/* ------------------------------------------------------------------ */

/**
 * Compute HMAC-SHA256 hex digest.
 * Intentionally exported so tests can generate expected values.
 */
export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Constant-time HMAC comparison (prevents timing oracles).
 */
export function safeCompare(a: string, b: string): boolean {
  // Pad to same length with a known byte so timingSafeEqual doesn't throw.
  const aBuf = Buffer.from(a.padEnd(64, "\0"));
  const bBuf = Buffer.from(b.padEnd(64, "\0"));
  if (aBuf.length !== bBuf.length) {
    // Lengths differ → not equal, but still do a dummy comparison to avoid timing leak.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

/* ------------------------------------------------------------------ */
/* ConnectorConformance test kit (T4.1)                                 */
/* ------------------------------------------------------------------ */

/**
 * Fixtures passed to runConformance.
 * Provide only what the connector under test supports.
 */
export interface ConformanceFixtures {
  orgId: string;
  /** For AclCapable: pairs of [nativePermissions, expectedAcl] */
  aclCases?: Array<{
    native: NativePermissions;
    expected: SourceAcl;
    label?: string;
  }>;
  /** For WebhookCapable: a valid signed webhook payload */
  validWebhook?: {
    headers: Record<string, string>;
    rawBody: string;
    ctx: WebhookContext;
  };
  /** For WebhookCapable: a tampered payload that must be rejected */
  tamperedWebhook?: {
    headers: Record<string, string>;
    rawBody: string;
    ctx: WebhookContext;
  };
  /** For BackfillCapable: a SyncContext (uses injected fetch, no network) */
  backfillCtx?: SyncContext;
  /** Expected ingest shape from backfill (first item, for externalId stability) */
  backfillExpected?: {
    connector: string;
    externalId: string;
  };
}

export interface ConformanceResult {
  passed: boolean;
  failures: string[];
}

/**
 * runConformance — call from tests to assert every connector invariant.
 *
 * Usage:
 *   const r = await runConformance(new NotionConnector(cfg), fixtures);
 *   expect(r.passed).toBe(true);
 */
export async function runConformance(
  connector: SourceConnector,
  fixtures: ConformanceFixtures
): Promise<ConformanceResult> {
  const failures: string[] = [];

  const fail = (msg: string) => failures.push(`[${connector.name}] ${msg}`);

  // 1. name is non-empty
  if (!connector.name || connector.name.trim() === "") {
    fail("name must be a non-empty string");
  }

  // 2. ACL invariants
  if (connector.mapAcl) {
    if (!fixtures.aclCases || fixtures.aclCases.length === 0) {
      fail("mapAcl present but no aclCases provided in fixtures");
    } else {
      for (const { native, expected, label } of fixtures.aclCases) {
        const lbl = label ?? JSON.stringify(native).slice(0, 60);

        // 2a. Deterministic
        const r1 = connector.mapAcl(native);
        const r2 = connector.mapAcl(native);
        if (JSON.stringify(r1) !== JSON.stringify(r2)) {
          fail(`mapAcl not deterministic for: ${lbl}`);
        }

        // 2b. No accidental public: expected.public must be explicitly true in source
        if (r1.public === true && expected.public !== true) {
          fail(`mapAcl returned public=true but expected.public is not true for: ${lbl}`);
        }

        // 2c. allow[] matches expected
        const gotAllow = [...r1.allow].sort();
        const wantAllow = [...expected.allow].sort();
        if (JSON.stringify(gotAllow) !== JSON.stringify(wantAllow)) {
          fail(
            `mapAcl allow[] mismatch for ${lbl}: got [${gotAllow}] want [${wantAllow}]`
          );
        }

        // 2d. public matches
        if (!!r1.public !== !!expected.public) {
          fail(
            `mapAcl public mismatch for ${lbl}: got ${r1.public} want ${expected.public}`
          );
        }
      }
    }
  }

  // 3. Webhook verification
  if (connector.verifyWebhook) {
    if (fixtures.validWebhook) {
      const { headers, rawBody, ctx } = fixtures.validWebhook;
      const ok = connector.verifyWebhook(headers, rawBody, ctx);
      if (!ok) fail("verifyWebhook rejected a valid webhook");
    }
    if (fixtures.tamperedWebhook) {
      const { headers, rawBody, ctx } = fixtures.tamperedWebhook;
      const bad = connector.verifyWebhook(headers, rawBody, ctx);
      if (bad) fail("verifyWebhook accepted a tampered webhook");
    }
  }

  // 4. Backfill: externalId stability (idempotent ingest key)
  if (connector.backfill && fixtures.backfillCtx && fixtures.backfillExpected) {
    try {
      const gen = connector.backfill(fixtures.backfillCtx);
      const first = await gen.next();
      if (first.done || !first.value) {
        fail("backfill yielded no items");
      } else {
        const { source } = first.value;
        if (source.connector !== fixtures.backfillExpected.connector) {
          fail(
            `backfill source.connector: got "${source.connector}" want "${fixtures.backfillExpected.connector}"`
          );
        }
        if (source.externalId !== fixtures.backfillExpected.externalId) {
          fail(
            `backfill externalId: got "${source.externalId}" want "${fixtures.backfillExpected.externalId}"`
          );
        }
        // Run again to confirm idempotency (same externalId on second call)
        const gen2 = connector.backfill(fixtures.backfillCtx);
        const first2 = await gen2.next();
        if (!first2.done && first2.value) {
          if (first2.value.source.externalId !== source.externalId) {
            fail("backfill externalId not stable across calls (not idempotent)");
          }
        }
      }
    } catch (e) {
      fail(`backfill threw unexpectedly: ${(e as Error).message}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
