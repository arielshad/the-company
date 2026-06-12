import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { Onboarding } from "./onboarding/Onboarding.js";
import { useOnboarding, useToasts } from "./lib/store.js";
import { Dashboard } from "./pages/Dashboard.js";
import { BrainPage } from "./pages/Brain.js";
import { GraphPage } from "./pages/Graph.js";
import { AgentsPage } from "./pages/Agents.js";
import { WorkflowsPage } from "./pages/Workflows.js";
import { SkillsPage } from "./pages/Skills.js";
import { GovernancePage } from "./pages/Governance.js";
import { IntegrationsPage } from "./pages/Integrations.js";
import { SettingsPage } from "./pages/Settings.js";

function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const onb = useOnboarding();
  return (
    <HashRouter>
      {!onb.completed && <Onboarding />}
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/brain" element={<BrainPage />} />
        <Route path="/graph" element={<GraphPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/connectors" element={<Navigate to="/integrations" replace />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/governance" element={<GovernancePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <Toaster />
    </HashRouter>
  );
}
