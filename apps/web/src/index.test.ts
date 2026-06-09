import { describe, it, expect } from "vitest";
import { route, builderPalette } from "./index.js";
import type { Canvas } from "@companyos/dsl";

describe("web BFF routes", () => {
  it("serves health probes", () => {
    expect(route("GET", "/healthz").status).toBe(200);
    expect(route("GET", "/readyz").status).toBe(200);
  });

  it("serves the builder palette with all node types", () => {
    const res = route("GET", "/api/builder/palette");
    expect(res.status).toBe(200);
    expect(builderPalette().map((p) => p.type)).toContain("approval");
    expect((res.body as any).triggers).toContain("zoom_transcript");
  });

  it("compiles a valid canvas to DSL", () => {
    const canvas: Canvas = {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { trigger: "manual" } },
        { id: "s", type: "brain_search", position: { x: 0, y: 1 }, data: { query: "x" } },
        { id: "e", type: "end", position: { x: 0, y: 2 }, data: {} }
      ],
      edges: [
        { id: "1", source: "t", target: "s" },
        { id: "2", source: "s", target: "e" }
      ]
    };
    const res = route("POST", "/api/builder/compile", { canvas, meta: { id: "w", orgId: "acme", name: "n" } });
    expect(res.status).toBe(200);
    expect((res.body as any).validation.valid).toBe(true);
  });

  it("returns 422 for an invalid canvas (no end)", () => {
    const canvas: Canvas = {
      nodes: [{ id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { trigger: "manual" } }],
      edges: []
    };
    const res = route("POST", "/api/builder/compile", { canvas, meta: { id: "w", orgId: "acme", name: "n" } });
    expect(res.status).toBe(422);
  });

  it("404s unknown routes", () => {
    expect(route("GET", "/nope").status).toBe(404);
  });
});
