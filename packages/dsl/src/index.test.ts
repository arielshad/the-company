import { describe, it, expect } from "vitest";
import {
  validateWorkflow,
  canvasToDsl,
  dslToCanvas,
  type Workflow,
  type Canvas
} from "./index.js";

function validWorkflow(): Workflow {
  return {
    id: "wf1",
    orgId: "acme",
    name: "demo",
    version: 1,
    state: "published",
    trigger: { id: "t1", type: "trigger", trigger: "manual" },
    nodes: [
      { id: "search", type: "brain_search", query: "{{t1.topic}}" },
      { id: "cond", type: "condition" },
      { id: "approve", type: "approval" },
      { id: "write", type: "memory_write" },
      { id: "done", type: "end" }
    ],
    edges: [
      { from: "t1", to: "search" },
      { from: "search", to: "cond" },
      { from: "cond", to: "approve", when: "true" },
      { from: "cond", to: "write", when: "false" },
      { from: "approve", to: "write" },
      { from: "write", to: "done" }
    ],
    permissions: { runAs: "agent", requiredRelations: [] },
    memoryWritePolicy: { allowedTypes: ["decision"], minConfidence: 0.5 },
    evalPolicy: { evals: [], gate: "advisory", thresholds: {} }
  };
}

describe("validateWorkflow", () => {
  it("accepts a valid workflow", () => {
    const r = validateWorkflow(validWorkflow());
    expect(r.valid, JSON.stringify(r.errors)).toBe(true);
  });

  it("invariant 1: rejects missing reachable end", () => {
    const wf = validWorkflow();
    wf.nodes = wf.nodes.filter((n) => n.type !== "end");
    wf.edges = wf.edges.filter((e) => e.to !== "done");
    const r = validateWorkflow(wf);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "no_end")).toBe(true);
  });

  it("invariant 1: rejects two triggers", () => {
    const wf = validWorkflow();
    wf.nodes.push({ id: "t2", type: "trigger", trigger: "manual" });
    wf.edges.push({ from: "t2", to: "done" });
    const r = validateWorkflow(wf);
    expect(r.errors.some((e) => e.code === "trigger_count")).toBe(true);
  });

  it("invariant 2: rejects an illegal (non-loop) cycle", () => {
    const wf = validWorkflow();
    wf.edges.push({ from: "write", to: "search" }); // back edge to non-loop
    const r = validateWorkflow(wf);
    expect(r.errors.some((e) => e.code === "cycle")).toBe(true);
  });

  it("invariant 2: allows a cycle that targets a loop node", () => {
    const wf = validWorkflow();
    wf.nodes.push({ id: "loop", type: "loop", maxIterations: 3 });
    wf.edges = [
      { from: "t1", to: "loop" },
      { from: "loop", to: "search" },
      { from: "search", to: "loop", when: "retry" },
      { from: "loop", to: "done", when: "exit" }
    ];
    wf.nodes = wf.nodes.filter((n) => !["cond", "approve", "write"].includes(n.id));
    const r = validateWorkflow(wf);
    expect(r.valid, JSON.stringify(r.errors)).toBe(true);
  });

  it("invariant 3: condition needs labelled branches", () => {
    const wf = validWorkflow();
    wf.edges = wf.edges.map((e) =>
      e.from === "cond" ? { from: e.from, to: e.to } : e
    );
    const r = validateWorkflow(wf);
    expect(r.errors.some((e) => e.code === "condition_branches")).toBe(true);
  });

  it("invariant 4: unknown tool rejected when registry given", () => {
    const wf = validWorkflow();
    wf.nodes.push({ id: "tcall", type: "tool", tool: "github.create_issue" });
    wf.edges.push({ from: "write", to: "tcall" }, { from: "tcall", to: "done" });
    const r = validateWorkflow(wf, { knownTools: new Set(["slack.notify"]) });
    expect(r.errors.some((e) => e.code === "unknown_tool")).toBe(true);

    const r2 = validateWorkflow(wf, { knownTools: new Set(["github.create_issue"]) });
    expect(r2.errors.some((e) => e.code === "unknown_tool")).toBe(false);
  });

  it("invariant 5: gate=block requires an eval before external effects", () => {
    const wf = validWorkflow();
    wf.evalPolicy = { evals: ["factuality"], gate: "block", thresholds: { factuality: 0.8 } };
    // write (external effect) has no eval ancestor → error
    const r = validateWorkflow(wf);
    expect(r.errors.some((e) => e.code === "ungated_effect")).toBe(true);

    // insert eval before write
    wf.nodes.push({ id: "ev", type: "eval" });
    wf.edges = [
      { from: "t1", to: "search" },
      { from: "search", to: "cond" },
      { from: "cond", to: "ev", when: "true" },
      { from: "cond", to: "ev", when: "false" },
      { from: "ev", to: "write" },
      { from: "write", to: "done" }
    ];
    wf.nodes = wf.nodes.filter((n) => n.id !== "approve");
    const r2 = validateWorkflow(wf);
    expect(r2.errors.some((e) => e.code === "ungated_effect")).toBe(false);
  });

  it("invariant 6: template ref must be upstream", () => {
    const wf = validWorkflow();
    // search references {{write.x}} but write is downstream
    wf.nodes = wf.nodes.map((n) =>
      n.id === "search" ? { ...n, query: "{{write.summary}}" } : n
    );
    const r = validateWorkflow(wf);
    expect(r.errors.some((e) => e.code === "non_upstream_ref")).toBe(true);
  });
});

describe("canvas <-> dsl compiler", () => {
  it("round-trips canvas -> dsl -> canvas with fidelity", () => {
    const canvas: Canvas = {
      nodes: [
        { id: "t1", type: "trigger", position: { x: 0, y: 0 }, data: { trigger: "manual" } },
        { id: "s", type: "brain_search", position: { x: 0, y: 100 }, data: { query: "hi", topK: 5 } },
        { id: "e", type: "end", position: { x: 0, y: 200 }, data: {} }
      ],
      edges: [
        { id: "e0", source: "t1", target: "s" },
        { id: "e1", source: "s", target: "e" }
      ]
    };
    const dsl = canvasToDsl(canvas, { id: "wf", orgId: "acme", name: "x" });
    expect(dsl.trigger.id).toBe("t1");
    expect(dsl.nodes.find((n) => n.id === "s")?.topK).toBe(5);

    const back = dslToCanvas(dsl);
    expect(back.nodes.map((n) => n.id).sort()).toEqual(["e", "s", "t1"]);
    expect(back.nodes.find((n) => n.id === "s")?.data).toMatchObject({ query: "hi", topK: 5 });
    expect(back.edges.map((e) => [e.source, e.target])).toEqual([
      ["t1", "s"],
      ["s", "e"]
    ]);

    // the recompiled dsl validates
    expect(validateWorkflow(dsl).valid).toBe(true);
  });

  it("throws when canvas has no trigger", () => {
    expect(() =>
      canvasToDsl({ nodes: [], edges: [] }, { id: "w", orgId: "a", name: "n" })
    ).toThrow();
  });
});
