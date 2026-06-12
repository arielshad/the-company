/**
 * Budgeted LLM judges (T3.4) behind the eval-service `Evaluator` interface.
 *
 * When ANTHROPIC_API_KEY is set, `factuality` and `hallucination_risk` are
 * scored by a real model (judge tier: claude-sonnet-4-6); otherwise they fall
 * back to the deterministic heuristics in @companyos/eval-service so CI stays
 * offline. The cheap deterministic pre-filters (source_coverage, policy, tone)
 * are unchanged and run first per the eval policy.
 *
 * The Anthropic dependency lives here (server-only core), NOT in eval-service,
 * so the browser bundle and offline tests never pull the SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EVALUATORS, type Evaluator, type EvalInput } from "@companyos/eval-service";

const JUDGE_SCHEMA = {
  type: "object",
  required: ["factuality", "hallucination_risk", "rationale"],
  properties: {
    factuality: { type: "number", minimum: 0, maximum: 1, description: "fraction of claims grounded in the citations/source (1=fully grounded)" },
    hallucination_risk: { type: "number", minimum: 0, maximum: 1, description: "1=clearly grounded & safe, 0=likely fabricated/unsupported" },
    rationale: { type: "string" }
  }
} as const;

const JUDGE_SYSTEM = `You are a strict factuality judge for an AI company-memory pipeline.
Given extracted CLAIMS and their CITATIONS (quotes from source), score how well the
claims are grounded. "factuality" = fraction of claims supported by a citation.
"hallucination_risk" is HIGH-IS-SAFE: 1.0 when every claim is clearly supported,
near 0 when claims are unsupported or fabricated. Be conservative: unsupported
claims must lower both scores.`;

interface Judgment {
  factuality: number;
  hallucinationRisk: number;
  detail: string;
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

async function runJudge(apiKey: string, model: string, input: EvalInput): Promise<Judgment> {
  const claims = (input.claims ?? []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none)";
  const citations =
    (input.citations ?? []).map((c) => `- [${c.sourceRef}] "${c.quote}"`).join("\n") || "(none)";
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const msg = await client.messages.create({
    model,
    max_tokens: 512,
    system: JUDGE_SYSTEM,
    tool_choice: { type: "tool", name: "record_judgment" },
    tools: [{ name: "record_judgment", description: "Record the factuality judgment.", input_schema: JUDGE_SCHEMA as any }],
    messages: [{ role: "user", content: `CLAIMS:\n${claims}\n\nCITATIONS:\n${citations}\n\nTEXT:\n${input.text ?? ""}` }]
  });
  const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const out = (tool?.input as Record<string, unknown>) ?? {};
  return {
    factuality: clamp01(out.factuality),
    hallucinationRisk: clamp01(out.hallucination_risk),
    detail: String(out.rationale ?? "llm judge")
  };
}

/**
 * Build the LLM-backed factuality + hallucination_risk evaluators. Both share a
 * single model call per EvalInput (memoized by input identity). On any model
 * error the call falls back to the deterministic heuristic so a transient LLM
 * outage degrades to the cheap judge rather than blocking the whole gate.
 */
export function createLlmJudges(opts: { apiKey?: string; model?: string } = {}): Record<string, Evaluator> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Offline / no key: keep deterministic heuristics (factuality, hallucination_risk).
    return { factuality: EVALUATORS.factuality!, hallucination_risk: EVALUATORS.hallucination_risk! };
  }
  const model = opts.model ?? "claude-sonnet-4-6";
  const cache = new WeakMap<object, Promise<Judgment>>();
  const judge = (input: EvalInput): Promise<Judgment> => {
    let p = cache.get(input as object);
    if (!p) {
      p = runJudge(apiKey, model, input).catch((err) => {
        // Fail soft to the heuristic so a model outage doesn't wrongly block/allow.
        const f = EVALUATORS.factuality!(input) as { score: number };
        const h = EVALUATORS.hallucination_risk!(input) as { score: number };
        return { factuality: f.score, hallucinationRisk: h.score, detail: `llm judge unavailable: ${(err as Error).message}` };
      });
      cache.set(input as object, p);
    }
    return p;
  };
  return {
    factuality: async (input) => {
      const j = await judge(input);
      return { id: "factuality", score: j.factuality, detail: j.detail };
    },
    hallucination_risk: async (input) => {
      const j = await judge(input);
      return { id: "hallucination_risk", score: j.hallucinationRisk };
    }
  };
}
