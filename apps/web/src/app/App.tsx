import { HashRouter, Routes, Route } from "react-router-dom";
import { Onboarding } from "./onboarding/Onboarding.js";
import { useOnboarding, useToasts } from "./lib/store.js";
import { Dashboard } from "./pages/Dashboard.js";
import { BrainPage } from "./pages/Brain.js";
import { AgentsPage } from "./pages/Agents.js";
import { WorkflowsPage } from "./pages/Workflows.js";
import { SkillsPage } from "./pages/Skills.js";
import { GovernancePage } from "./pages/Governance.js";
import { ConnectorsPage } from "./pages/Connectors.js";
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
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/governance" element={<GovernancePage />} />
        <Route path="/connectors" element={<ConnectorsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <Toaster />
    </HashRouter>
  );
}
