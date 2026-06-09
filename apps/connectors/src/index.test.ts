import { describe, it, expect } from "vitest";
import { ZoomConnector, ConnectorRegistry, cleanTranscript } from "./index.js";
import { sampleZoomTranscript, ORG } from "@companyos/testing";

describe("ZoomConnector", () => {
  it("parses a transcript into an ingest payload with provenance + a trigger", () => {
    const res = new ZoomConnector().handle(ORG, sampleZoomTranscript);
    expect(res.ingest.source.connector).toBe("zoom");
    expect(res.ingest.source.externalId).toBe(sampleZoomTranscript.meetingId);
    expect(res.ingest.source.url).toContain("zoom.example");
    expect(res.trigger.kind).toBe("zoom_transcript");
    expect(String(res.trigger.data.transcript)).toContain("SSO");
  });

  it("rejects an invalid payload", () => {
    expect(() => new ZoomConnector().handle(ORG, { foo: "bar" })).toThrow();
  });
});

describe("ConnectorRegistry health (FR-2.4)", () => {
  it("tracks ok and error health", () => {
    const reg = new ConnectorRegistry();
    reg.register(new ZoomConnector());
    reg.handle("zoom", ORG, sampleZoomTranscript);
    expect(reg.healthAll().find((h) => h.name === "zoom")?.ok).toBe(true);

    expect(() => reg.handle("zoom", ORG, {})).toThrow();
    const h = reg.healthAll().find((x) => x.name === "zoom")!;
    expect(h.ok).toBe(false);
    expect(h.lastError).toBeDefined();
  });
});

describe("cleanTranscript", () => {
  it("trims blank lines and whitespace", () => {
    expect(cleanTranscript("  a \n\n  b \n")).toBe("a\nb");
  });
});
