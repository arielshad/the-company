import { InMemoryAuthz, type Principal } from "@companyos/auth";

/** Shared fixtures & helpers for unit/integration/BDD/e2e (docs/05). */

export const ORG = "acme";

export const alice: Principal = {
  type: "user",
  id: "user:alice",
  orgId: ORG,
  roles: ["admin"],
  groups: ["leadership"]
};
export const bob: Principal = {
  type: "user",
  id: "user:bob",
  orgId: ORG,
  roles: ["member"],
  groups: ["engineering"]
};
export const opsAgent: Principal = {
  type: "agent",
  id: "agent:ops-bot",
  orgId: ORG,
  roles: ["agent"],
  groups: []
};

/** Seed an authz engine with the acme org, brain, team, and members. */
export function seedAcme(fga = new InMemoryAuthz()): InMemoryAuthz {
  fga.write({ subject: "user:alice", relation: "admin", object: `org:${ORG}` });
  fga.write({ subject: "user:bob", relation: "member", object: `org:${ORG}` });
  fga.write({ subject: "agent:ops-bot", relation: "member", object: `org:${ORG}` });
  fga.write({ subject: `org:${ORG}`, relation: "parent", object: `brain:${ORG}` });
  fga.write({ subject: `org:${ORG}`, relation: "parent", object: `team:engineering` });
  fga.write({ subject: "user:bob", relation: "member", object: "team:engineering" });
  // leadership group → reader on a restricted scope brain object handled via source ACL
  return fga;
}

/** A realistic Zoom meeting transcript fixture for the flagship scenario. */
export const sampleZoomTranscript = {
  meetingId: "zoom-meet-9981",
  topic: "Acme x Globex — Q3 renewal",
  startedAt: "2026-06-08T15:00:00.000Z",
  participants: ["Alice (Acme)", "Sam (Globex)"],
  transcript: [
    "Alice: Thanks for joining. Let's cover the Q3 renewal for Globex.",
    "Sam: We're happy overall but need SSO and SOC2 before we expand seats.",
    "Alice: Understood. Decision: we will prioritize SSO for the August release.",
    "Sam: Great. Our budget for expansion is approved at 250 seats.",
    "Alice: Risk: if SSO slips past August, Globex may delay the expansion.",
    "Alice: Action item: Bob to scope SSO work and open a Jira ticket this week."
  ].join("\n")
};

/** Minimal structured expectation of what extraction should yield. */
export const expectedExtraction = {
  decisions: ["prioritize SSO for the August release"],
  actionItems: ["Bob to scope SSO work and open a Jira ticket"],
  risks: ["SSO slipping past August may delay Globex expansion"],
  customerFacts: ["Globex expansion budget approved at 250 seats"],
  customer: "Globex"
};
