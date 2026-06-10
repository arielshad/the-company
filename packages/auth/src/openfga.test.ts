/**
 * Unit tests for OpenFgaAuthz — run entirely in-process with a fake transport.
 * No OpenFGA server required.
 */

import { describe, it, expect, vi } from "vitest";
import { OpenFgaAuthz } from "./openfga.js";
import type { FgaTransport } from "./openfga.js";
import type { Tuple } from "./index.js";

function makeFakeTransport(checkResult = false): FgaTransport & {
  writeCalls: Array<{ writes: Tuple[]; deletes: Tuple[] }>;
} {
  const writeCalls: Array<{ writes: Tuple[]; deletes: Tuple[] }> = [];
  return {
    writeCalls,
    async write(writes: Tuple[], deletes: Tuple[]): Promise<void> {
      writeCalls.push({ writes, deletes });
    },
    async check(_subject: string, _relation: string, _object: string): Promise<boolean> {
      return checkResult;
    },
  };
}

describe("OpenFgaAuthz", () => {
  const tuple: Tuple = { subject: "user:alice", relation: "admin", object: "org:acme" };

  it("write(t) calls transport.write with [t] as writes and [] as deletes", async () => {
    const transport = makeFakeTransport();
    const engine = new OpenFgaAuthz(transport);

    await engine.write(tuple);

    expect(transport.writeCalls).toHaveLength(1);
    expect(transport.writeCalls[0]!.writes).toEqual([tuple]);
    expect(transport.writeCalls[0]!.deletes).toEqual([]);
  });

  it("delete(t) calls transport.write with [] as writes and [t] as deletes", async () => {
    const transport = makeFakeTransport();
    const engine = new OpenFgaAuthz(transport);

    await engine.delete(tuple);

    expect(transport.writeCalls).toHaveLength(1);
    expect(transport.writeCalls[0]!.writes).toEqual([]);
    expect(transport.writeCalls[0]!.deletes).toEqual([tuple]);
  });

  it("check returns true when transport returns true", async () => {
    const transport = makeFakeTransport(true);
    const engine = new OpenFgaAuthz(transport);

    const result = await engine.check("user:alice", "admin", "org:acme");

    expect(result).toBe(true);
  });

  it("check returns false when transport returns false", async () => {
    const transport = makeFakeTransport(false);
    const engine = new OpenFgaAuthz(transport);

    const result = await engine.check("user:bob", "admin", "org:acme");

    expect(result).toBe(false);
  });

  it("check delegates subject, relation, object to transport unchanged", async () => {
    const checkSpy = vi.fn(async () => true);
    const transport: FgaTransport = {
      write: vi.fn(async () => {}),
      check: checkSpy,
    };
    const engine = new OpenFgaAuthz(transport);

    await engine.check("user:carol", "reader", "brain:eng");

    expect(checkSpy).toHaveBeenCalledWith("user:carol", "reader", "brain:eng");
  });

  it("write and delete calls are independent — each records one transport call", async () => {
    const transport = makeFakeTransport();
    const engine = new OpenFgaAuthz(transport);

    const t1: Tuple = { subject: "user:alice", relation: "member", object: "org:acme" };
    const t2: Tuple = { subject: "user:bob", relation: "member", object: "org:acme" };

    await engine.write(t1);
    await engine.delete(t2);

    expect(transport.writeCalls).toHaveLength(2);
    expect(transport.writeCalls[0]!.writes).toEqual([t1]);
    expect(transport.writeCalls[0]!.deletes).toEqual([]);
    expect(transport.writeCalls[1]!.writes).toEqual([]);
    expect(transport.writeCalls[1]!.deletes).toEqual([t2]);
  });
});
