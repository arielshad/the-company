import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Onboarding } from "./onboarding/Onboarding.js";
import { BrainPage } from "./pages/Brain.js";
import { AgentsPage } from "./pages/Agents.js";
import { IntegrationsPage } from "./pages/Integrations.js";

/** Canned API responses so the thin client renders without a live server. */
const FIXTURES: Record<string, unknown> = {
  "/api/me": { id: "user:alice", type: "user", orgId: "acme", roles: ["admin"], groups: ["leadership"] },
  "/api/approvals": { approvals: [] },
  "/api/connectors": {
    connectors: [
      { name: "notion", label: "Notion", category: "Docs & wiki", kind: "source", configured: true, connected: false, demo: true },
      { name: "zoom", label: "Zoom", category: "Meetings", kind: "webhook", configured: true, connected: true, demo: false }
    ]
  },
  "/api/agents": { agents: [{ id: "a1", name: "Atlas", role: "CEO", status: "active", budgetMonthlyUsd: 200 }] },
  "/api/agents/org-chart": { orgChart: [] },
  "/api/brain/search": { hits: [] },
  "/api/brain/graph/entities": { entities: [] },
  "/api/audit": { audit: [], digest: "0" },
  "/api/budgets": { budgets: [] },
  "/api/skills": { skills: [] },
  "/api/workflows": { workflows: [] },
  "/api/runs": { runs: [] }
};

function fixtureFor(url: string): unknown {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
  return FIXTURES[path] ?? {};
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = typeof input === "string" ? input : String(input);
    return { ok: true, status: 200, text: async () => JSON.stringify(fixtureFor(url)) } as unknown as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Onboarding wizard", () => {
  it("opens on the welcome step and advances", () => {
    render(<Onboarding />);
    expect(screen.getByText("Welcome to CompanyOS")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect(screen.getByText("The four pillars")).toBeInTheDocument();
  });

  it("can be skipped", () => {
    render(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(JSON.parse(localStorage.getItem("companyos.onboarding.v1")!).completed).toBe(true);
  });
});

describe("pages render against the API", () => {
  it("Brain page shows the search UI", () => {
    render(<MemoryRouter><BrainPage /></MemoryRouter>);
    expect(screen.getAllByText("Company Brain").length).toBeGreaterThan(0);
  });

  it("Agents page lists agents fetched from the API", async () => {
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    expect(await screen.findAllByText("Atlas")).toHaveLength(1);
  });

  it("Integrations page lists the connector catalog", async () => {
    render(<MemoryRouter><IntegrationsPage /></MemoryRouter>);
    expect(await screen.findByText("Notion")).toBeInTheDocument();
    expect(screen.getByText("Zoom")).toBeInTheDocument(); // catalog rendered from the API
  });
});
