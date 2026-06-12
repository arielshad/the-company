import { useState } from "react";
import {
  Brain,
  Bot,
  Workflow,
  ShieldCheck,
  Plug,
  Sparkles,
  Rocket,
  CheckCircle2,
  PlayCircle,
  ArrowRight
} from "lucide-react";
import { completeOnboarding, markDone, pushToast, useOnboarding } from "../lib/store.js";
import { api } from "../lib/api.js";

const SAMPLE_TRANSCRIPT = {
  meetingId: "zoom-onboarding-1",
  topic: "Acme x Globex — Q3 renewal",
  participants: ["Alice (Acme)", "Sam (Globex)"],
  transcript: [
    "Alice: Thanks for joining — let's cover the Q3 renewal for Globex.",
    "Sam: We're happy, but we need SSO and SOC2 before we expand seats.",
    "Alice: Understood. Decision: we will prioritize SSO for the August release.",
    "Sam: Our budget for expansion is approved at 250 seats.",
    "Alice: Risk — if SSO slips past August, Globex may delay the expansion.",
    "Alice: Action item — Bob to scope SSO work and open a Jira ticket this week."
  ].join("\n")
};

interface Step {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}

function LiveDemo() {
  const [phase, setPhase] = useState<"idle" | "running" | "awaiting" | "done">("idle");

  const run = async () => {
    setPhase("running");
    try {
      // Drives the REAL flagship server-side: webhook → ingest → extract → eval
      // gate → (pause for) approval. Customer-sensitive runs pause here.
      const res = await api.webhook("zoom", SAMPLE_TRANSCRIPT);
      if (res.status === "paused") {
        setPhase("awaiting");
      } else {
        markDone("ran_workflow");
        setPhase("done");
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Run failed", "error");
      setPhase("idle");
    }
  };

  const approve = async () => {
    try {
      const pending = await api.approvals();
      if (pending[0]) await api.decideApproval(pending[0].id, "approved", "Reviewed — ok to record");
      markDone("ran_workflow");
      pushToast("Workflow resumed — memory written, ticket created, Slack notified");
      setPhase("done");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Approve failed", "error");
    }
  };

  return (
    <div className="card" style={{ background: "var(--bg-elev-2)" }}>
      <div className="row">
        <PlayCircle size={18} color="var(--brand)" />
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Live demo · Zoom transcript → company brain</div>
      </div>
      <p className="faint mt-2" style={{ fontSize: 12.5 }}>
        This runs the <b>real</b> workflow on the server: extract → eval gate → approval → memory write → Jira task → Slack.
      </p>

      {phase === "idle" && (
        <button className="btn primary mt-3" onClick={run}>
          <PlayCircle size={16} /> Run the workflow
        </button>
      )}
      {phase === "running" && <div className="badge blue mt-3">Running…</div>}

      {phase === "awaiting" && (
        <div className="mt-3">
          <div className="badge amber mb-2">⏸ Paused — human approval required (customer-sensitive)</div>
          <p className="faint" style={{ fontSize: 12.5 }}>
            The workflow paused at an <b>approval</b> node because Globex data is customer-sensitive. As an approver, you decide:
          </p>
          <button className="btn primary mt-2" onClick={approve}>
            <CheckCircle2 size={16} /> Approve &amp; resume
          </button>
        </div>
      )}

      {phase === "done" && (
        <div className="mt-3">
          <div className="badge green mb-2"><CheckCircle2 size={13} /> Completed</div>
          <p className="faint mt-2" style={{ fontSize: 12.5 }}>
            Every step was authorized and written to an immutable audit log. Search “Globex SSO” in the
            Company Brain to find the new memory with its source, or open Governance for the audit trail.
          </p>
        </div>
      )}
    </div>
  );
}

export function Onboarding() {
  const onb = useOnboarding();
  const [step, setStep] = useState(onb.step ?? 0);

  const steps: Step[] = [
    {
      icon: <Rocket size={26} />,
      title: "Welcome to CompanyOS",
      body: (
        <div>
          <p className="onb-text">
            CompanyOS is <b>the agent operating system for your company</b> — a living company brain with a managed AI
            workforce. Connect your knowledge, build agents and workflows, and let approved AI act on trusted context,
            all under enterprise governance.
          </p>
          <p className="onb-text mt-3">This 2-minute tour shows the four pieces and ends with a live run you can try.</p>
        </div>
      )
    },
    {
      icon: <Brain size={26} />,
      title: "The four pillars",
      body: (
        <div>
          {[
            { ic: <Brain size={18} />, t: "Company Brain", d: "Permission-aware memory & search over Notion, Drive, GitHub, meetings, decisions." },
            { ic: <Bot size={18} />, t: "AI Workforce", d: "Agents with roles, goals, tools, budgets and reporting lines — managed like employees." },
            { ic: <Workflow size={18} />, t: "Workflows", d: "Drag-and-drop agentic workflows: triggers, search, agents, conditions, approvals, effects." },
            { ic: <ShieldCheck size={18} />, t: "Governance", d: "Permissions, human approvals, budgets, evals and an immutable audit trail on everything." }
          ].map((f) => (
            <div className="feature-row" key={f.t}>
              <div className="ic">{f.ic}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{f.t}</div>
                <div className="faint" style={{ fontSize: 13 }}>{f.d}</div>
              </div>
            </div>
          ))}
        </div>
      )
    },
    {
      icon: <Plug size={26} />,
      title: "1 · Connect your knowledge",
      body: (
        <div>
          <p className="onb-text">
            CompanyOS plugs into where work already happens. Connected sources are ingested into the brain with their
            original permissions preserved, so agents never surface something a person couldn't see.
          </p>
          <div className="row wrap mt-3" style={{ gap: 8 }}>
            {["Notion", "Google Drive", "GitHub", "Slack", "Gmail", "Calendar", "Zoom", "Jira"].map((c) => (
              <span className="badge" key={c}>
                <Plug size={12} /> {c}
              </span>
            ))}
          </div>
        </div>
      )
    },
    {
      icon: <Bot size={26} />,
      title: "2 · Build your AI workforce",
      body: (
        <p className="onb-text">
          Create agents from templates (CEO, PM, Engineer, Researcher, Sales, Support). Each has a <b>goal</b>,
          allowed <b>tools</b>, a monthly <b>budget</b> (metered per run, with hard stops), and a <b>manager</b> — so you
          get a real org chart of accountable workers, not anonymous prompts.
        </p>
      )
    },
    {
      icon: <Workflow size={26} />,
      title: "3 · Compose workflows",
      body: (
        <div>
          <p className="onb-text">
            Workflows wire it together on a visual canvas that compiles to a versioned, validated spec. Nodes include:
          </p>
          <div className="row wrap mt-3" style={{ gap: 6 }}>
            {["trigger", "brain_search", "agent", "tool", "condition", "loop", "approval", "eval", "memory_write", "task", "notify"].map((n) => (
              <span className="badge blue" key={n}>{n}</span>
            ))}
          </div>
        </div>
      )
    },
    {
      icon: <Sparkles size={26} />,
      title: "4 · See it run, end to end",
      body: (
        <div>
          <p className="onb-text mb-3">
            Here's the flagship workflow turning a Zoom meeting into governed company memory — running for real, right now:
          </p>
          <LiveDemo />
        </div>
      )
    },
    {
      icon: <CheckCircle2 size={26} />,
      title: "You're ready",
      body: (
        <div>
          <p className="onb-text">You've seen the whole loop. From here you can:</p>
          <div className="mt-3">
            {[
              "Ask the Company Brain a question and get cited answers",
              "Create an agent and run a task within budget",
              "Open the workflow builder and edit the canvas",
              "Review approvals, budgets and the audit log in Governance"
            ].map((x) => (
              <div className="feature-row" key={x}>
                <CheckCircle2 size={16} color="var(--accent)" />
                <div style={{ fontSize: 13.5 }}>{x}</div>
              </div>
            ))}
          </div>
        </div>
      )
    }
  ];

  const last = step === steps.length - 1;
  const cur = steps[step]!;

  const next = () => {
    if (last) {
      completeOnboarding();
      return;
    }
    setStep(step + 1);
  };

  return (
    <div className="onb-overlay">
      <div className="onb">
        <div className="onb-top">
          <div className="onb-steps">
            {steps.map((_, i) => (
              <div key={i} className={`onb-pip ${i < step ? "done" : i === step ? "current" : ""}`} />
            ))}
          </div>
          <button className="btn ghost sm" onClick={() => completeOnboarding()}>Skip</button>
        </div>
        <div className="onb-body">
          <div className="onb-icon">{cur.icon}</div>
          <h2 className="onb-title">{cur.title}</h2>
          {cur.body}
        </div>
        <div className="onb-foot">
          <span className="faint" style={{ fontSize: 12 }}>
            Step {step + 1} of {steps.length}
          </span>
          <div className="spacer" />
          {step > 0 && (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button className="btn primary" onClick={next}>
            {last ? "Get started" : "Next"} <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
