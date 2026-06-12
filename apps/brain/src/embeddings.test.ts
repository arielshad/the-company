import { describe, it, expect, vi } from "vitest";
import type { SourceAcl } from "@companyos/auth";
import { seedAcme, alice, ORG } from "@companyos/testing";
import { BrainService } from "./index.js";
import { HashingEmbedder, OpenAiCompatibleEmbedder, cosineVec, type Embedder } from "./embeddings.js";

describe("HashingEmbedder (deterministic offline default)", () => {
  it("is deterministic and dimension-stable", async () => {
    const e = new HashingEmbedder(128);
    const [a1] = await e.embed(["single sign-on rollout"]);
    const [a2] = await e.embed(["single sign-on rollout"]);
    expect(a1).toEqual(a2);
    expect(a1).toHaveLength(128);
  });

  it("similar texts score higher than unrelated ones", async () => {
    const e = new HashingEmbedder(256);
    const [q] = await e.embed(["sso rollout plan for august"]);
    const [near] = await e.embed(["sso rollout plan august release"]);
    const [far] = await e.embed(["lunch menu and office snacks"]);
    expect(cosineVec(q!, near!)).toBeGreaterThan(cosineVec(q!, far!));
  });
});

describe("OpenAiCompatibleEmbedder (Infinity/TEI/vLLM/Ollama)", () => {
  it("POSTs to {baseUrl}/embeddings and preserves input order", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] }
        ]
      })
    });
    const e = new OpenAiCompatibleEmbedder(
      { baseUrl: "http://localhost:7997/v1", model: "BAAI/bge-m3", apiKey: "dummy" },
      fetchFn as unknown as typeof fetch
    );
    const vecs = await e.embed(["first", "second"]);
    expect(vecs).toEqual([[1, 0], [0, 1]]); // re-sorted by index
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://localhost:7997/v1/embeddings");
    expect((init as any).headers.Authorization).toBe("Bearer dummy");
    expect(JSON.parse((init as any).body)).toEqual({ model: "BAAI/bge-m3", input: ["first", "second"] });
  });

  it("throws on a response/length mismatch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) });
    const e = new OpenAiCompatibleEmbedder({ baseUrl: "http://x/v1", model: "m" }, fetchFn as unknown as typeof fetch);
    await expect(e.embed(["a", "b"])).rejects.toThrow(/shape mismatch/);
  });
});

describe("BrainService uses the vector path when an Embedder is wired", () => {
  const publicAcl: SourceAcl = { allow: [], public: true };

  /** Fake embedder: ranks by a per-title vector so we can assert the vector path drives ordering. */
  function fakeEmbedder(map: Record<string, number[]>): Embedder {
    return {
      embed: async (texts) => texts.map((t) => map[t.split("\n")[0]!] ?? map[t] ?? [0, 0, 1])
    };
  }

  it("ranks by embedding cosine, not token overlap", async () => {
    // Query "alpha" embeds near "Zebra doc" (no shared tokens) and far from
    // "Alpha doc" (shares the query token) — so a token-overlap ranker would put
    // Alpha first; the vector path must put Zebra first.
    const embedder = fakeEmbedder({
      alpha: [1, 0, 0],
      "Zebra doc": [1, 0, 0],
      "Alpha doc": [0, 1, 0]
    });
    const brain = new BrainService(seedAcme(), undefined, undefined, embedder);
    brain.ingest({ orgId: ORG, source: { connector: "t", externalId: "z" }, title: "Zebra doc", content: "zoo animals", sourceAcl: publicAcl });
    brain.ingest({ orgId: ORG, source: { connector: "t", externalId: "a" }, title: "Alpha doc", content: "alpha alpha", sourceAcl: publicAcl });

    const hits = await brain.search(alice, { orgId: ORG, query: "alpha" });
    expect(hits[0]?.title).toBe("Zebra doc"); // vector-near wins despite zero token overlap
  });
});
