/**
 * Embedding seam (T3.3). The brain scores retrieval with a real vector cosine
 * when an `Embedder` is wired; otherwise it falls back to the bag-of-words
 * cosine in index.ts so CI stays offline & deterministic.
 *
 * The production embedder targets any OpenAI-compatible `/v1/embeddings` server
 * (Infinity, HuggingFace TEI, vLLM, Ollama) — e.g. Infinity + BAAI/bge-m3:
 *   docker run -p 7997:7997 michaelf34/infinity v2 --model-id BAAI/bge-m3
 *   EMBEDDINGS_BASE_URL=http://localhost:7997/v1  EMBEDDINGS_MODEL=BAAI/bge-m3
 */

export interface Embedder {
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity between two equal-length dense vectors. */
export function cosineVec(a: number[], b: number[]): number {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    ma += x * x;
    mb += y * y;
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}

export interface OpenAiCompatibleEmbedderConfig {
  /** Base URL including the version segment, e.g. http://localhost:7997/v1 */
  baseUrl: string;
  /** Model id, e.g. BAAI/bge-m3 or text-embedding-3-small. */
  model: string;
  /** Optional bearer key ("dummy" for many self-hosted servers). NEVER logged. */
  apiKey?: string;
}

interface EmbeddingsResponse {
  data?: Array<{ embedding: number[]; index?: number }>;
  error?: { message?: string } | string;
}

/**
 * Embedder over any OpenAI-compatible `POST {baseUrl}/embeddings`. fetch is
 * injectable for tests; production uses globalThis.fetch.
 */
export class OpenAiCompatibleEmbedder implements Embedder {
  private readonly fetchFn: typeof fetch;
  constructor(
    private readonly config: OpenAiCompatibleEmbedderConfig,
    fetchFn?: typeof fetch
  ) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.fetchFn(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify({ model: this.config.model, input: texts })
    });
    if (!res.ok) {
      throw new Error(`embeddings: HTTP ${res.status} from ${this.config.baseUrl}`);
    }
    const data = (await res.json()) as EmbeddingsResponse;
    if (!data.data || data.data.length !== texts.length) {
      throw new Error("embeddings: response shape mismatch (missing/incomplete data[])");
    }
    // Preserve input order (sort by index if the server returned one).
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((d) => d.embedding);
  }
}

/**
 * Deterministic offline embedder: feature-hashing of tokens into a fixed-dim
 * L2-normalized vector. Exercises the vector path with no network — the default
 * for tests/CI. NOT semantic (synonyms stay unrelated, same limitation as
 * bag-of-words); production should configure a real OpenAI-compatible endpoint.
 */
export class HashingEmbedder implements Embedder {
  constructor(private readonly dim = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const bucket = h % this.dim;
      const sign = (h >>> 31) & 1 ? -1 : 1; // signed hashing reduces collisions
      const cur = v[bucket] ?? 0;
      v[bucket] = cur + sign;
    }
    // L2 normalize
    let mag = 0;
    for (const x of v) mag += x * x;
    mag = Math.sqrt(mag);
    if (mag === 0) return v;
    return v.map((x) => x / mag);
  }
}

/** FNV-1a 32-bit hash → unsigned int. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
