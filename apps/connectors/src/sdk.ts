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
