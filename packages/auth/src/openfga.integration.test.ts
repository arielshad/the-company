/**
 * Integration tests for the OpenFGA backend.
 *
 * These tests require a running OpenFGA server. They are automatically skipped
 * when OPENFGA_API_URL is not set (e.g. during local development).
 *
 * In CI, start the server with:
 *   docker run -d --name openfga -p 8080:8080 openfga/openfga:latest run
 * then set OPENFGA_API_URL=http://localhost:8080 before running.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { OpenFgaAuthz, createOpenFgaTransport, setupOpenFgaStore } from "./openfga.js";

const URL = process.env.OPENFGA_API_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!URL)("OpenFGA integration", () => {
  let engine: OpenFgaAuthz;

  beforeAll(async () => {
    // Read the canonical DSL model from the infra directory
    const modelPath = join(__dirname, "../../../infra/platform/openfga/model.fga");
    const dsl = readFileSync(modelPath, "utf-8");

    // Create an isolated store and write the model
    const { storeId, authorizationModelId } = await setupOpenFgaStore(URL!, dsl);

    // Build the engine
    engine = new OpenFgaAuthz(
      createOpenFgaTransport({ apiUrl: URL!, storeId, authorizationModelId })
    );

    // Seed relationship tuples that mirror the in-memory engine semantics
    await engine.write({ subject: "user:alice", relation: "admin", object: "org:acme" });
    await engine.write({ subject: "user:bob", relation: "member", object: "org:acme" });
    await engine.write({ subject: "org:acme", relation: "parent", object: "brain:acme" });
    await engine.write({ subject: "brain:acme", relation: "parent", object: "memory_object:m1" });
    await engine.write({ subject: "user:carol", relation: "member", object: "team:eng" });
    await engine.write({ subject: "team:eng#member", relation: "reader", object: "brain:eng" });
  });

  it("alice is writer on brain:acme (via admin on org:acme -> admin from parent)", async () => {
    expect(await engine.check("user:alice", "writer", "brain:acme")).toBe(true);
  });

  it("alice is reader on brain:acme (via writer -> reader)", async () => {
    expect(await engine.check("user:alice", "reader", "brain:acme")).toBe(true);
  });

  it("bob is reader on brain:acme (via member on org:acme -> member from parent)", async () => {
    expect(await engine.check("user:bob", "reader", "brain:acme")).toBe(true);
  });

  it("bob is NOT writer on brain:acme (member != admin)", async () => {
    expect(await engine.check("user:bob", "writer", "brain:acme")).toBe(false);
  });

  it("bob is viewer on memory_object:m1 (via reader on brain:acme -> reader from parent)", async () => {
    expect(await engine.check("user:bob", "viewer", "memory_object:m1")).toBe(true);
  });

  it("carol is reader on brain:eng (via team:eng#member -> reader)", async () => {
    expect(await engine.check("user:carol", "reader", "brain:eng")).toBe(true);
  });

  it("dan (no tuples) is NOT reader on brain:eng", async () => {
    expect(await engine.check("user:dan", "reader", "brain:eng")).toBe(false);
  });
});
