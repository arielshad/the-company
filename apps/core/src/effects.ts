/**
 * Outbound-effect seam: `task` (e.g. Jira) and `notify` (e.g. Slack) handlers.
 * Real Slack/Jira clients land in T4.5/T4.6; until then (and in dev/CI) effects
 * are captured in memory so the flagship thread runs end-to-end and tests can
 * assert "exactly once". All effects run BEHIND the approval gate in the engine.
 */
import type { TaskFn, NotifyFn, RunContext } from "@companyos/workflow-engine";

export interface CapturedTicket { id: string; summary: string; target: string }
export interface CapturedSlack { channel: string; text: string }

export interface EffectHandlers {
  tasks: Record<string, TaskFn>;
  notifiers: Record<string, NotifyFn>;
  tickets: CapturedTicket[];
  slack: CapturedSlack[];
}

export function createInMemoryEffects(): EffectHandlers {
  const tickets: CapturedTicket[] = [];
  const slack: CapturedSlack[] = [];
  return {
    tickets,
    slack,
    tasks: {
      create_tickets: (_input: Record<string, unknown>, ctx: RunContext) => {
        const summary = String((ctx.extract as any)?.actionItems?.[0] ?? "follow up");
        const ticket = { id: `TASK-${tickets.length + 1}`, summary, target: "jira" };
        tickets.push(ticket);
        return ticket;
      }
    },
    notifiers: {
      slack: (_input: Record<string, unknown>, ctx: RunContext) => {
        const decision = String((ctx.extract as any)?.decisions?.[0] ?? "(none)");
        const msg = { channel: "#team-updates", text: `New decision recorded: ${decision}` };
        slack.push(msg);
        return msg;
      }
    }
  };
}
