/**
 * SlackSourceConnector (T7.4) — Slack read connector (channels → brain).
 *
 * Complements the outbound SlackNotifier (slack.ts). OAuth2 against Slack
 * (oauth.v2.access), backfill/incremental over conversations.list +
 * conversations.history, conservative channel-membership ACL mapping.
 * fetch is injected; tokens are never logged. Follows the SDK v2 pattern.
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
  TokenRef
} from "./sdk.js";

export interface SlackConnectorConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope?: string;
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  subtype?: string;
}

export interface SlackNativePermissions extends Record<string, unknown> {
  channelId: string;
  isPrivate?: boolean;
  teamId?: string;
}

interface SlackListResponse {
  ok: boolean;
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
  error?: string;
}
interface SlackHistoryResponse {
  ok: boolean;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
  error?: string;
}
interface SlackOAuthResponse {
  ok: boolean;
  access_token?: string;
  team?: { id?: string };
  error?: string;
}

const SLACK_API = "https://slack.com/api";
const SLACK_AUTHORIZE = "https://slack.com/oauth/v2/authorize";
const DEFAULT_SCOPE = "channels:read,channels:history,groups:read,groups:history";

/**
 * Map a Slack channel to SourceAcl. CONSERVATIVE:
 * - private channel → allow ["channel:<id>"] (members only).
 * - public channel → allow ["workspace:<teamId>"] (workspace members, NOT the
 *   public web); if the team id is unknown we DENY (allow: []) rather than widen.
 * - never public=true: Slack content is never world-readable.
 */
export function mapSlackAcl(native: NativePermissions): SourceAcl {
  const n = native as unknown as SlackNativePermissions;
  if (n.isPrivate) return { allow: [`channel:${n.channelId}`] };
  if (n.teamId) return { allow: [`workspace:${n.teamId}`] };
  return { allow: [] };
}

export function slackMessageToIngest(
  msg: SlackMessage,
  channel: SlackChannel,
  orgId: string,
  teamId?: string
): IngestPayload {
  const source: SourceRef = {
    connector: "slack",
    externalId: `${channel.id}:${msg.ts}`,
    url: `https://slack.com/archives/${channel.id}/p${msg.ts.replace(".", "")}`
  };
  const title = `#${channel.name ?? channel.id}`;
  return {
    orgId,
    source,
    title,
    content: msg.text ?? "",
    sourceAcl: mapSlackAcl({ channelId: channel.id, isPrivate: channel.is_private, teamId } as unknown as NativePermissions)
  };
}

export class SlackSourceConnector
  implements SourceConnector, OAuthCapable, BackfillCapable, IncrementalCapable, AclCapable
{
  readonly name = "slack";
  private readonly scope: string;
  constructor(private readonly cfg: SlackConnectorConfig) {
    this.scope = cfg.scope ?? DEFAULT_SCOPE;
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      scope: this.scope,
      redirect_uri: this.cfg.redirectUri,
      state
    });
    return `${SLACK_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string, fetchFn?: typeof fetch): Promise<TokenRef> {
    const f = fetchFn ?? globalThis.fetch;
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: redirectUri
    });
    const res = await f(`${SLACK_API}/oauth.v2.access`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) throw new Error(`slack: exchangeCode failed ${res.status}`);
    const data = (await res.json()) as SlackOAuthResponse;
    if (!data.ok || !data.access_token) throw new Error(`slack: oauth error "${data.error ?? "no token"}"`);
    return { accessToken: data.access_token, scope: this.scope };
  }

  async refresh(_refreshToken: string, _fetchFn?: typeof fetch): Promise<TokenRef> {
    throw new Error("slack: token refresh not supported; re-authorize via OAuth");
  }

  mapAcl(native: NativePermissions): SourceAcl {
    return mapSlackAcl(native);
  }

  async *backfill(ctx: SyncContext): AsyncGenerator<IngestPayload> {
    yield* this.#sync(ctx, undefined);
  }
  async *incremental(ctx: SyncContext, since: string): AsyncGenerator<IngestPayload> {
    // Slack history `oldest` is a Unix timestamp (seconds).
    const oldest = (Date.parse(since) / 1000).toString();
    yield* this.#sync(ctx, oldest);
  }

  async *#sync(ctx: SyncContext, oldest: string | undefined): AsyncGenerator<IngestPayload> {
    const f = ctx.fetch ?? globalThis.fetch;
    const channels = await this.#listChannels(f, ctx.accessToken);
    for (const ch of channels) {
      if (ch.is_archived) continue;
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ channel: ch.id, limit: "100" });
        if (oldest) params.set("oldest", oldest);
        if (cursor) params.set("cursor", cursor);
        const res = await f(`${SLACK_API}/conversations.history?${params.toString()}`, {
          headers: { Authorization: `Bearer ${ctx.accessToken}` }
        });
        if (!res.ok) throw new Error(`slack: history failed ${res.status}`);
        const data = (await res.json()) as SlackHistoryResponse;
        if (!data.ok) throw new Error(`slack: history error "${data.error}"`);
        for (const msg of data.messages ?? []) {
          if (msg.subtype) continue; // skip joins/leaves/system messages
          if (!msg.text) continue;
          yield slackMessageToIngest(msg, ch, ctx.orgId);
        }
        cursor = data.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }
  }

  async #listChannels(f: typeof fetch, token: string): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ types: "public_channel,private_channel", limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const res = await f(`${SLACK_API}/conversations.list?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`slack: conversations.list failed ${res.status}`);
      const data = (await res.json()) as SlackListResponse;
      if (!data.ok) throw new Error(`slack: conversations.list error "${data.error}"`);
      out.push(...(data.channels ?? []));
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }
}
