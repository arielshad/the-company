/**
 * eval-service (docs/04 §5, PHASE-08): quality/factuality/policy/tone/
 * source-coverage/hallucination evaluators with gating.
 *
 * Judges here are deterministic heuristics so the suite is testable offline.
 * In production, `factuality`/`tone` are backed by a budgeted LLM judge
 * (T08.2) behind the same `Evaluator` interface.
 */

export interface Citation {
  sourceRef: string;
  quote: string;
}

export interface EvalInput {
  text?: string;
  claims?: string[];
  citations?: Citation[];
  toolsUsed?: string[];
  allowedTools?: string[];
  [k: string]: unknown;
}

export interface EvalResult {
  id: string;
  score: number; // 0..1
  detail?: string;
}

/** An evaluator may be a deterministic heuristic (sync) or a budgeted LLM judge (async). */
export type Evaluator = (input: EvalInput) => EvalResult | Promise<EvalResult>;

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Fraction of claims that are supported by at least one citation quote. */
export const sourceCoverage = (input: EvalInput): EvalResult => {
  const claims = input.claims ?? [];
  const citations = input.citations ?? [];
  if (claims.length === 0) return { id: "source_coverage", score: 1, detail: "no claims" };
  let covered = 0;
  for (const claim of claims) {
    const claimTokens = new Set(tokenize(claim).filter((t) => t.length > 3));
    const supported = citations.some((c) => {
      const q = new Set(tokenize(c.quote));
      let overlap = 0;
      for (const t of claimTokens) if (q.has(t)) overlap++;
      return claimTokens.size > 0 && overlap / claimTokens.size >= 0.3;
    });
    if (supported) covered++;
  }
  return { id: "source_coverage", score: covered / claims.length, detail: `${covered}/${claims.length}` };
};

/** Heuristic factuality: claims' key terms must appear in supporting citations. */
export const factuality = (input: EvalInput): EvalResult => {
  const cov = sourceCoverage(input);
  // factuality is at least as strict as coverage; penalize uncited claims harder
  return { id: "factuality", score: cov.score, detail: cov.detail };
};

/** Policy: output must only use allowed tools (no forbidden external effects). */
export const policy = (input: EvalInput): EvalResult => {
  const used = input.toolsUsed ?? [];
  const allowed = new Set(input.allowedTools ?? []);
  if (used.length === 0) return { id: "policy", score: 1 };
  const violations = used.filter((t) => allowed.size > 0 && !allowed.has(t));
  return {
    id: "policy",
    score: violations.length === 0 ? 1 : 0,
    detail: violations.length ? `forbidden tools: ${violations.join(",")}` : "ok"
  };
};

/** Tone: penalize obviously unprofessional tokens (placeholder heuristic). */
export const tone = (input: EvalInput): EvalResult => {
  const bad = ["stupid", "idiot", "hate", "damn"];
  const toks = tokenize(input.text ?? "");
  const hits = toks.filter((t) => bad.includes(t)).length;
  return { id: "tone", score: hits === 0 ? 1 : Math.max(0, 1 - hits * 0.5) };
};

/** Hallucination risk: high when there is text but no citations. */
export const hallucinationRisk = (input: EvalInput): EvalResult => {
  const hasText = (input.text ?? "").length > 0 || (input.claims ?? []).length > 0;
  const hasCites = (input.citations ?? []).length > 0;
  const score = !hasText ? 1 : hasCites ? 0.9 : 0.4;
  return { id: "hallucination_risk", score };
};

export const EVALUATORS: Record<string, Evaluator> = {
  source_coverage: sourceCoverage,
  factuality,
  policy,
  tone,
  hallucination_risk: hallucinationRisk
};

export interface SuiteOptions {
  evals: string[];
  thresholds: Record<string, number>;
  gate?: "advisory" | "block";
  /**
   * Per-eval overrides (e.g. a budgeted LLM judge for factuality/hallucination
   * injected by the server). Falls back to the deterministic EVALUATORS.
   */
  evaluators?: Record<string, Evaluator>;
}

export interface SuiteResult {
  passed: boolean;
  blocked: boolean; // true when gate=block and !passed
  results: EvalResult[];
  failures: string[];
}

/**
 * Run a set of evaluators and apply thresholds + gating. Async because an
 * injected evaluator (LLM judge) may call a model; deterministic heuristics
 * resolve immediately. Per-eval overrides come from `opts.evaluators`.
 */
export async function runSuite(input: EvalInput, opts: SuiteOptions): Promise<SuiteResult> {
  const results: EvalResult[] = [];
  const failures: string[] = [];
  for (const id of opts.evals) {
    const ev = opts.evaluators?.[id] ?? EVALUATORS[id];
    if (!ev) {
      failures.push(`unknown_eval:${id}`);
      results.push({ id, score: 0, detail: "unknown evaluator" });
      continue;
    }
    const r = await ev(input);
    results.push(r);
    const threshold = opts.thresholds[id] ?? 0;
    if (r.score < threshold) failures.push(id);
  }
  const passed = failures.length === 0;
  return { passed, blocked: opts.gate === "block" && !passed, results, failures };
}
