import { describe, it, expect, vi } from "vitest";
import { SlackSourceConnector, mapSlackAcl, slackMessageToIngest } from "./slack-source.js";
import type { NativePermissions } from "./sdk.js";

const ORG = "acme";
const cfg = { clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb" };

describe("mapSlackAcl — conservative channel ACL", () => {
  const cases: Array<{ label: string; native: Record<string, unknown>; expected: { allow: string[]; public?: boolean } }> = [
    { label: "private channel → members-only (channel principal)", native: { channelId: "C1", isPrivate: true }, expected: { allow: ["channel:C1"] } },
    { label: "public channel with team → workspace-scoped", native: { channelId: "C2", isPrivate: false, teamId: "T9" }, expected: { allow: ["workspace:T9"] } },
    { label: "public channel without team → DENY (never widen)", native: { channelId: "C3", isPrivate: false }, expected: { allow: [] } },
    { label: "never public=true", native: { channelId: "C4", isPrivate: false, teamId: "T1" }, expected: { allow: ["workspace:T1"] } }
  ];
  for (const { label, native, expected } of cases) {
    it(label, () => {
      const acl = mapSlackAcl(native as unknown as NativePermissions);
      expect(acl.allow).toEqual(expected.allow);
      expect(Boolean(acl.public)).toBe(false);
    });
  }
});

describe("slackMessageToIngest", () => {
  it("builds provenance + archive url", () => {
    const p = slackMessageToIngest({ ts: "1700000000.000100", text: "we shipped SSO" }, { id: "C1", name: "eng", is_private: true }, ORG);
    expect(p.source.connector).toBe("slack");
    expect(p.source.externalId).toBe("C1:1700000000.000100");
    expect(p.title).toBe("#eng");
    expect(p.content).toBe("we shipped SSO");
    expect(p.sourceAcl).toEqual({ allow: ["channel:C1"] });
  });
});

describe("SlackSourceConnector backfill (mock fetch)", () => {
  function mockFetch(channels: unknown, history: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      if (url.includes("conversations.list")) return { ok: true, json: async () => channels } as unknown as Response;
      const m = url.match(/channel=([^&]+)/);
      const ch = m?.[1] ?? "";
      return { ok: true, json: async () => history[ch] ?? { ok: true, messages: [] } } as unknown as Response;
    });
  }

  it("lists channels and yields non-system messages with channel ACL", async () => {
    const fetchFn = mockFetch(
      { ok: true, channels: [{ id: "C1", name: "eng", is_private: true }, { id: "C2", name: "general", is_private: false, is_archived: true }] },
      { C1: { ok: true, messages: [{ ts: "1.1", text: "hello" }, { ts: "1.2", subtype: "channel_join", text: "joined" }] } }
    );
    const c = new SlackSourceConnector(cfg);
    const out = [];
    for await (const p of c.backfill({ orgId: ORG, accessToken: "xoxb-1", fetch: fetchFn as unknown as typeof fetch })) out.push(p);
    expect(out).toHaveLength(1); // archived channel skipped, system message skipped
    expect(out[0]?.source.externalId).toBe("C1:1.1");
    expect(out[0]?.sourceAcl).toEqual({ allow: ["channel:C1"] });
  });

  it("authorizeUrl includes client_id, scope and state", () => {
    const url = new SlackSourceConnector(cfg).authorizeUrl("xyz");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=xyz");
    expect(decodeURIComponent(url)).toContain("channels:read");
  });
});
