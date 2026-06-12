import { describe, it, expect } from "vitest";
import { runSuite, sourceCoverage, policy, type Evaluator } from "./index.js";

describe("sourceCoverage", () => {
  it("scores 1 when every claim is cited", () => {
    const r = sourceCoverage({
      claims: ["We will prioritize SSO for the August release"],
      citations: [{ sourceRef: "zoom:1", quote: "we will prioritize SSO for the August release" }]
    });
    expect(r.score).toBe(1);
  });
  it("scores 0 when claims are uncited", () => {
    const r = sourceCoverage({ claims: ["Globex signed a $1M deal"], citations: [] });
    expect(r.score).toBe(0);
  });
});

describe("policy", () => {
  it("fails on forbidden tool use", () => {
    expect(policy({ toolsUsed: ["email.send"], allowedTools: ["slack.notify"] }).score).toBe(0);
    expect(policy({ toolsUsed: ["slack.notify"], allowedTools: ["slack.notify"] }).score).toBe(1);
  });
});

describe("runSuite gating", () => {
  const goodInput = {
    claims: ["prioritize SSO for the August release"],
    citations: [{ sourceRef: "z", quote: "Decision: we will prioritize SSO for the August release." }],
    toolsUsed: ["slack.notify"],
    allowedTools: ["slack.notify"]
  };

  it("passes and does not block when thresholds met", async () => {
    const r = await runSuite(goodInput, {
      evals: ["source_coverage", "factuality", "policy"],
      thresholds: { source_coverage: 0.7, factuality: 0.7, policy: 1 },
      gate: "block"
    });
    expect(r.passed).toBe(true);
    expect(r.blocked).toBe(false);
  });

  it("blocks external effects when an eval fails under gate=block", async () => {
    const r = await runSuite(
      { claims: ["uncited claim about revenue"], citations: [] },
      { evals: ["source_coverage"], thresholds: { source_coverage: 0.7 }, gate: "block" }
    );
    expect(r.passed).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.failures).toContain("source_coverage");
  });

  it("advisory gate records failure without blocking", async () => {
    const r = await runSuite(
      { claims: ["uncited"], citations: [] },
      { evals: ["source_coverage"], thresholds: { source_coverage: 0.7 }, gate: "advisory" }
    );
    expect(r.passed).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it("flags unknown evaluators", async () => {
    const r = await runSuite({}, { evals: ["does_not_exist"], thresholds: {} });
    expect(r.failures).toContain("unknown_eval:does_not_exist");
  });

  it("awaits an injected async evaluator (LLM-judge seam) and gates on its score", async () => {
    // A budgeted LLM judge is async; runSuite must await it and apply the threshold.
    const asyncJudge: Evaluator = async () => ({ id: "factuality", score: 0.2, detail: "llm" });
    const r = await runSuite(
      { claims: ["x"], citations: [{ sourceRef: "z", quote: "x" }] },
      {
        evals: ["factuality"],
        thresholds: { factuality: 0.7 },
        gate: "block",
        evaluators: { factuality: asyncJudge }
      }
    );
    expect(r.results[0]?.score).toBe(0.2); // the injected judge overrode the heuristic
    expect(r.blocked).toBe(true);
  });
});
