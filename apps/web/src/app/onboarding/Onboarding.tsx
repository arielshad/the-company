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
import { completeOnboarding, markDone, mutate, pushToast, useOnboarding, usePlatform } from "../lib/store.js";
import { ZoomConnector } from "@companyos/connectors";

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
  const p = usePlatform();
  const [phase, setPhase] = useState<"idle" | "running" | "awaiting" | "done">("idle");
  const [runId, setRunId] = useState<string | null>(null);

  const run = async () => {
    setPhase("running");
    const ev = new ZoomConnector().handle(p.user.orgId, SAMPLE_TRANSCRIPT);
    const res = await mutate(() =>
      p.gateway.callTool(p.opsAgent, "workflow.trigger", { workflowId: "wf_zoom_to_brain", data: ev.trigger.data })
    );
    const out = (res as any).result as { runId: string; status: string };
    setRunId(out.runId);
    setPhase(out.status === "paused" ? "awaiting" : "done");
  };

  const approve = async () => {
    const pending = p.listPendingApprovals();
    if (pending[0]) p.governance.decide(pending[0].id, p.user, "approved", "Reviewed — ok to record");
    if (runId) await mutate(() => p.engine.resume(runId));
    markDone("ran_workflow");
    pushToast("Workflow completed — memory written, ticket created, Slack notified");
    setPhase("done");
  };

  return (
    <div className="card" style={{ background: "var(--bg-elev-2)" }}>
      <div className="row">
        <PlayCircle size={18} color="var(--brand)" />
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>Live demo · Zoom transcript → company brain</div>
      </div>
      <p className="faint mt-2" style={{ fontSize: 12.5 }}>
        This runs the <b>real</b> workflow: extract → eval gate → approval → memory write → Jira task → Slack.
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
          <div className="grid cols-3 mt-2">
            <div className="card center"><div className="stat" style={{ fontSize: 22 }}>{p.brain.count("acme")}</div><div className="faint" style={{ fontSize: 11 }}>memories</div></div>
            <div className="card center"><div className="stat" style={{ fontSize: 22 }}>{p.tickets.length}</div><div className="faint" style={{ fontSize: 11 }}>Jira tickets</div></div>
            <div className="card center"><div className="stat" style={{ fontSize: 22 }}>{p.slack.length}</div><div className="faint" style={{ fontSize: 11 }}>Slack posts</div></div>
          </div>
          <p className="faint mt-3" style={{ fontSize: 12.5 }}>
            Every step was authorized and written to an immutable audit log. Search “Globex SSO” in the Brain to find the new memory with its source.
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
