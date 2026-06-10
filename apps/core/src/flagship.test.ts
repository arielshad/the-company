import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";
import { createAuthz, createStores } from "./stores.js";
import { CorePlatform } from "./platform.js";
import { principalFromClaims } from "@companyos/auth";

async function makePlatform() {
  const config = loadConfig({ PERSISTENCE: "memory", AUTHZ_BACKEND: "memory", AUTH_DEV: "1", DEFAULT_ORG: "acme" } as NodeJS.ProcessEnv);
  const authz = createAuthz(config);
  const { audit, memoryStore } = await createStores(config);
  const platform = new CorePlatform({ config, authz, audit, memoryStore });
  platform.seedDemo();
  return platform;
}

const opsAgent = principalFromClaims({ sub: "ops-bot", org_id: "acme", realm_access: { roles: ["agent"] } }, "acme");
const alice = principalFromClaims({ sub: "alice", org_id: "acme", realm_access: { roles: ["admin"] }, groups: ["leadership"] }, "acme");

describe("flagship: durable run resumes after approval and fires effects exactly once", () => {
  it("pauses at the gate, then approval drives it to completion", async () => {
    const platform = await makePlatform();
    const triggerData = { meetingId: "m-1", transcript: "We decided to prioritize SSO for the August release. SSO slipping past August may delay Globex expansion. Globex expansion budget approved at 250 seats." };

    const run = await platform.runWorkflow("wf_zoom_to_brain", opsAgent, triggerData);
    expect(run.status).toBe("paused");
    expect(run.awaiting?.approvalId).toBeTruthy();

    const pending = platform.listPendingApprovals("acme");
    expect(pending).toHaveLength(1);

    await platform.decideApproval(pending[0]!.id, alice, "approved");

    const after = platform.getRun(run.id)!;
    expect(after.status).toBe("completed");
    // effects past the gate fired exactly once
    expect(platform.effects.tickets).toHaveLength(1);
    expect(platform.effects.slack).toHaveLength(1);
  });

  it("a replayed run with the same meeting id does not double-send effects", async () => {
    const platform = await makePlatform();
    const triggerData = { meetingId: "m-dup", transcript: "We decided to prioritize SSO for the August release. SSO slipping past August may delay Globex expansion. Globex expansion budget approved at 250 seats." };

    const run1 = await platform.runWorkflow("wf_zoom_to_brain", opsAgent, triggerData);
    await platform.decideApproval(platform.listPendingApprovals("acme")[0]!.id, alice, "approved");
    expect(platform.getRun(run1.id)!.status).toBe("completed");

    // Replay the identical meeting (e.g. duplicate webhook): a new run, same idempotency key.
    const run2 = await platform.runWorkflow("wf_zoom_to_brain", opsAgent, triggerData);
    const pending2 = platform.listPendingApprovals("acme");
    if (pending2.length) await platform.decideApproval(pending2[0]!.id, alice, "approved");
    expect(platform.getRun(run2.id)!.status).toBe("completed");

    // Despite two runs, the external effects were deduped by meeting id.
    expect(platform.effects.tickets).toHaveLength(1);
    expect(platform.effects.slack).toHaveLength(1);
  });

  it("rejecting the approval fails the run and fires no effects", async () => {
    const platform = await makePlatform();
    const run = await platform.runWorkflow("wf_zoom_to_brain", opsAgent, { meetingId: "m-rej", transcript: "We decided to prioritize SSO for the August release. SSO slipping past August may delay Globex expansion. Globex expansion budget approved at 250 seats." });
    expect(run.status).toBe("paused");
    await platform.decideApproval(platform.listPendingApprovals("acme")[0]!.id, alice, "rejected");
    expect(platform.getRun(run.id)!.status).toBe("failed");
    expect(platform.effects.tickets).toHaveLength(0);
    expect(platform.effects.slack).toHaveLength(0);
  });
});
