import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Onboarding } from "./onboarding/Onboarding.js";
import { BrainPage } from "./pages/Brain.js";
import { AgentsPage } from "./pages/Agents.js";

beforeEach(() => localStorage.clear());

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
    // after skip the wizard completes (no welcome heading rendered by a fresh mount)
    expect(JSON.parse(localStorage.getItem("companyos.onboarding.v1")!).completed).toBe(true);
  });
});

describe("pages render", () => {
  it("Brain page shows the search UI", () => {
    render(
      <MemoryRouter>
        <BrainPage />
      </MemoryRouter>
    );
    // "Company Brain" appears in both the nav and the page title
    expect(screen.getAllByText("Company Brain").length).toBeGreaterThan(0);
  });

  it("Agents page lists the seeded workforce", () => {
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>
    );
    // seeded agents from the live platform (card + org chart)
    expect(screen.getAllByText("Atlas").length).toBeGreaterThan(0);
  });
});
