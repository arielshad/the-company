import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Brain,
  Bot,
  Workflow,
  Sparkles,
  ShieldCheck,
  Plug,
  Settings,
  HelpCircle,
  Search
} from "lucide-react";
import { startOnboarding, usePlatform } from "../lib/store.js";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, section: "Overview", end: true },
  { to: "/brain", label: "Company Brain", icon: Brain, section: "Knowledge" },
  { to: "/connectors", label: "Connectors", icon: Plug, section: "Knowledge" },
  { to: "/agents", label: "Agents", icon: Bot, section: "Workforce" },
  { to: "/workflows", label: "Workflows", icon: Workflow, section: "Workforce" },
  { to: "/skills", label: "Skills", icon: Sparkles, section: "Workforce" },
  { to: "/governance", label: "Governance", icon: ShieldCheck, section: "Control" },
  { to: "/settings", label: "Settings", icon: Settings, section: "Control" }
];

export function Shell({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  const p = usePlatform();
  const pending = p.listPendingApprovals().length;
  const sections = [...new Set(NAV.map((n) => n.section))];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">C</div>
          <div>
            <div className="name">CompanyOS</div>
            <div className="tag">agent operating system</div>
          </div>
        </div>
        {sections.map((s) => (
          <div key={s}>
            <div className="nav-section">{s}</div>
            {NAV.filter((n) => n.section === s).map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                <n.icon size={17} />
                <span>{n.label}</span>
                {n.to === "/governance" && pending > 0 && <span className="badge amber" style={{ marginLeft: "auto" }}>{pending}</span>}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          <button className="nav-item" style={{ width: "100%" }} onClick={() => startOnboarding()}>
            <HelpCircle size={17} />
            <span>Restart tour</span>
          </button>
          <div className="row" style={{ padding: "10px 11px", gap: 10 }}>
            <div className="avatar" style={{ width: 30, height: 30 }}>A</div>
            <div style={{ fontSize: 12.5 }}>
              <div style={{ fontWeight: 600 }}>Alice</div>
              <div className="faint">admin · acme</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="title">{title}</div>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <div className="spacer" />
          <NavLink to="/brain" className="btn ghost sm">
            <Search size={15} /> Ask the brain
          </NavLink>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
