/**
 * SlackNotifier tests (T4.5)
 *
 * All tests are network-free; fetch is injected via the constructor.
 * Covers: happy-path post, idempotency (no-op on duplicate key),
 * error propagation, and in-memory cache inspection.
 */

import { describe, it, expect, vi } from "vitest";
import { SlackNotifier, type PostMessageParams } from "./slack.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeSuccessResponse(channel = "C123", ts = "1234567890.123456") {
  return {
    ok: true,
    json: async () => ({ ok: true, channel, ts }),
  };
}

function makeMockFetch(responses: Array<typeof makeSuccessResponse>) {
  return vi.fn(
    ...responses.map((r) => () => Promise.resolve(r))
  );
}

const BOT_TOKEN = "xoxb-test-bot-token";

/* ------------------------------------------------------------------ */
/* Basic happy-path post                                               */
/* ------------------------------------------------------------------ */

describe("SlackNotifier.postMessage — basic", () => {
  it("posts to Slack and returns channel + ts", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse("C-general", "ts-001"));
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    const result = await notifier.postMessage({
      channel: "C-general",
      text: "Hello, world!",
      idempotencyKey: "run-1:step-1:notify",
    });

    expect(result.channel).toBe("C-general");
    expect(result.ts).toBe("ts-001");
    expect(result.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("sends Bearer token in Authorization header — never logs the token value", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse());
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    await notifier.postMessage({
      channel: "C-test",
      text: "Test",
      idempotencyKey: "run-2:step-1:notify",
    });

    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    // Must use Bearer auth; value not tested to avoid logging it in test output
    expect(headers?.["Authorization"]).toMatch(/^Bearer /);
  });

  it("sends Content-Type application/json", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse());
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    await notifier.postMessage({
      channel: "C-test",
      text: "Test",
      idempotencyKey: "run-3:step-1:notify",
    });

    const call = mockFetch.mock.calls[0];
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers?.["Content-Type"]).toContain("application/json");
  });

  it("includes thread_ts in body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse());
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    await notifier.postMessage({
      channel: "C-test",
      text: "Threaded reply",
      idempotencyKey: "run-4:step-1:notify",
      threadTs: "1234567890.000001",
    });

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call?.[1]?.body as string);
    expect(body.thread_ts).toBe("1234567890.000001");
  });

  it("includes blocks in body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse());
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "*Hello*" } }];

    await notifier.postMessage({
      channel: "C-test",
      text: "Fallback",
      idempotencyKey: "run-5:step-1:notify",
      blocks,
    });

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call?.[1]?.body as string);
    expect(body.blocks).toEqual(blocks);
  });
});

/* ------------------------------------------------------------------ */
/* Idempotency                                                          */
/* ------------------------------------------------------------------ */

describe("SlackNotifier idempotency", () => {
  it("returns cached result on second call with same key (no extra HTTP request)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse("C-idempotent", "ts-idem"));
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    const params: PostMessageParams = {
      channel: "C-idempotent",
      text: "Deploy complete",
      idempotencyKey: "run-10:step-3:notify",
    };

    const first = await notifier.postMessage(params);
    const second = await notifier.postMessage(params);

    // Only one HTTP call made
    expect(mockFetch).toHaveBeenCalledOnce();

    // First result is fresh
    expect(first.cached).toBe(false);
    expect(first.ts).toBe("ts-idem");

    // Second result is cached replay
    expect(second.cached).toBe(true);
    expect(second.channel).toBe("C-idempotent");
    expect(second.ts).toBe("ts-idem");
  });

  it("different idempotency keys result in separate posts", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse("C-general", "ts-a"))
      .mockResolvedValueOnce(makeSuccessResponse("C-general", "ts-b"));

    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    const r1 = await notifier.postMessage({
      channel: "C-general",
      text: "Message 1",
      idempotencyKey: "run-11:step-1:notify",
    });
    const r2 = await notifier.postMessage({
      channel: "C-general",
      text: "Message 2",
      idempotencyKey: "run-11:step-2:notify",
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(r1.ts).toBe("ts-a");
    expect(r2.ts).toBe("ts-b");
  });

  it("hasSent returns true after posting, false before", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse());
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);
    const key = "run-12:step-1:notify";

    expect(notifier.hasSent(key)).toBe(false);

    await notifier.postMessage({ channel: "C", text: "Hi", idempotencyKey: key });

    expect(notifier.hasSent(key)).toBe(true);
  });

  it("getCached returns undefined before posting and the result after", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeSuccessResponse("C-x", "ts-cached"));
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);
    const key = "run-13:step-1:notify";

    expect(notifier.getCached(key)).toBeUndefined();

    await notifier.postMessage({ channel: "C-x", text: "Test", idempotencyKey: key });

    const cached = notifier.getCached(key);
    expect(cached?.ts).toBe("ts-cached");
    expect(cached?.cached).toBe(false); // stored result is the original (non-cached) result
  });

  it("sentCount reflects the number of unique keys sent", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeSuccessResponse());

    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);
    expect(notifier.sentCount).toBe(0);

    await notifier.postMessage({ channel: "C", text: "a", idempotencyKey: "k1" });
    expect(notifier.sentCount).toBe(1);

    // Replay same key — sentCount stays at 1
    await notifier.postMessage({ channel: "C", text: "a", idempotencyKey: "k1" });
    expect(notifier.sentCount).toBe(1);

    await notifier.postMessage({ channel: "C", text: "b", idempotencyKey: "k2" });
    expect(notifier.sentCount).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Error handling                                                       */
/* ------------------------------------------------------------------ */

describe("SlackNotifier error handling", () => {
  it("throws on non-ok HTTP response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    await expect(
      notifier.postMessage({ channel: "C", text: "Hi", idempotencyKey: "err-1" })
    ).rejects.toThrow("503");
  });

  it("throws on Slack API-level error (ok=false in body)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    });
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    await expect(
      notifier.postMessage({ channel: "C-nonexistent", text: "Hi", idempotencyKey: "err-2" })
    ).rejects.toThrow("channel_not_found");
  });

  it("throws when response is missing channel or ts", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }), // missing channel + ts
    });
    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);

    await expect(
      notifier.postMessage({ channel: "C", text: "Hi", idempotencyKey: "err-3" })
    ).rejects.toThrow("channel/ts");
  });

  it("does NOT cache a failed attempt — retrying with same key will re-post", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(makeSuccessResponse("C-retry", "ts-retry"));

    const notifier = new SlackNotifier(BOT_TOKEN, mockFetch as unknown as typeof fetch);
    const key = "run-retry:step-1:notify";

    // First attempt fails
    await expect(
      notifier.postMessage({ channel: "C-retry", text: "Hi", idempotencyKey: key })
    ).rejects.toThrow();

    // Key should NOT be cached (failure was not stored)
    expect(notifier.hasSent(key)).toBe(false);

    // Second attempt succeeds
    const result = await notifier.postMessage({ channel: "C-retry", text: "Hi", idempotencyKey: key });
    expect(result.ts).toBe("ts-retry");
    expect(result.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
