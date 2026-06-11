/**
 * SlackNotifier (T4.5 outbound)
 *
 * Real Slack chat.postMessage client via fetch.
 *
 * Key design properties:
 * 1. Idempotency: a caller-supplied idempotencyKey ensures that a replay
 *    of the same logical effect (e.g., a retried workflow node) does not
 *    double-post. The seen-keys map is in-memory; for durable idempotency
 *    across restarts, the workflow engine stores the key in run_steps (W1/T1.3).
 *
 * 2. Token injection: the bot token is passed at construction time and
 *    is NEVER logged. The notifier does not store it in any observable way.
 *
 * 3. fetch injection: callers in tests provide a mock fetch; production
 *    uses globalThis.fetch. This keeps tests network-free.
 *
 * 4. Error transparency: non-ok Slack API responses are thrown so the
 *    caller's workflow engine can decide whether to retry or escalate.
 */

/* ------------------------------------------------------------------ */
/* Slack API shapes                                                     */
/* ------------------------------------------------------------------ */

/** Parameters for a single postMessage call. */
export interface PostMessageParams {
  channel: string;
  text: string;
  /**
   * Caller-assigned idempotency key.
   * If a message with this key was already sent successfully, the call
   * is a no-op and the cached result is returned.
   *
   * Recommended: use a deterministic key derived from the run id + step id
   * (e.g., `${runId}:${stepId}:slack_notify`) so that workflow replays are safe.
   */
  idempotencyKey: string;
  /** Optional: thread_ts to post in a thread. */
  threadTs?: string;
  /** Optional: Slack blocks (structured message) as a JSON-serialisable array. */
  blocks?: unknown[];
}

/** The result of a postMessage call (or a cached no-op replay). */
export interface PostMessageResult {
  /** Slack channel id where the message was posted. */
  channel: string;
  /** Slack message timestamp (ts), which serves as the message id. */
  ts: string;
  /** True if this was a no-op replay (key seen; no HTTP call made). */
  cached: boolean;
}

/** Raw Slack chat.postMessage API response. */
interface SlackPostMessageResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* SlackNotifier                                                        */
/* ------------------------------------------------------------------ */

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

export class SlackNotifier {
  /** In-memory idempotency store: key → cached result. */
  private readonly sent = new Map<string, PostMessageResult>();
  private readonly fetchFn: typeof fetch;

  /**
   * @param botToken  Slack Bot User OAuth Token (starts with "xoxb-").
   *                  NEVER log this value.
   * @param fetchFn   Optional fetch override for testing.
   */
  constructor(
    private readonly botToken: string,
    fetchFn?: typeof fetch
  ) {
    // Store the injected fetch (or the global) — never log botToken
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /**
   * Post a message to Slack.
   *
   * Idempotency behaviour:
   * - First call with a given idempotencyKey: posts to Slack, caches the result.
   * - Subsequent calls with the same key: returns the cached result, no HTTP call.
   *
   * The caller is responsible for persisting idempotency keys across restarts
   * (the workflow engine stores them in run_steps.idempotencyKey per T1.3).
   */
  async postMessage(params: PostMessageParams): Promise<PostMessageResult> {
    // Idempotency check — no-op on seen key
    const prior = this.sent.get(params.idempotencyKey);
    if (prior !== undefined) {
      return { ...prior, cached: true };
    }

    // Build request body
    const body: Record<string, unknown> = {
      channel: params.channel,
      text: params.text,
    };
    if (params.threadTs) body["thread_ts"] = params.threadTs;
    if (params.blocks) body["blocks"] = params.blocks;

    // POST to Slack API — bearer token NEVER logged
    const res = await this.fetchFn(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`slack: HTTP error ${res.status} posting to channel ${params.channel}`);
    }

    const data = (await res.json()) as SlackPostMessageResponse;
    if (!data.ok) {
      throw new Error(`slack: API error "${data.error}" posting to channel ${params.channel}`);
    }

    if (!data.channel || !data.ts) {
      throw new Error("slack: postMessage succeeded but response missing channel/ts");
    }

    const result: PostMessageResult = {
      channel: data.channel,
      ts: data.ts,
      cached: false,
    };

    // Cache for idempotency
    this.sent.set(params.idempotencyKey, result);
    return result;
  }

  /**
   * Check if an idempotency key has already been used.
   * Useful for inspecting state in tests.
   */
  hasSent(idempotencyKey: string): boolean {
    return this.sent.has(idempotencyKey);
  }

  /**
   * Return the cached result for a previously-sent key, or undefined.
   */
  getCached(idempotencyKey: string): PostMessageResult | undefined {
    return this.sent.get(idempotencyKey);
  }

  /**
   * Expose the current number of cached entries (for testing/observability).
   */
  get sentCount(): number {
    return this.sent.size;
  }
}
