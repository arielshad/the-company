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

/** Stable idempotency key for an effect node within a run (dedupes replays). */
function effectKey(input: Record<string, unknown>, ctx: RunContext, kind: string): string {
  const subject = String((ctx.input as any)?.meetingId ?? (ctx.input as any)?.id ?? "run");
  return `${kind}:${subject}:${String((input as any)?.id ?? kind)}`;
}

export function createInMemoryEffects(): EffectHandlers {
  const tickets: CapturedTicket[] = [];
  const slack: CapturedSlack[] = [];
  // Idempotency ledger: an effect key maps to its first result, so a replayed
  // step returns the prior result instead of firing the side effect again.
  const seen = new Map<string, unknown>();
  return {
    tickets,
    slack,
    tasks: {
      create_tickets: (input: Record<string, unknown>, ctx: RunContext) => {
        const key = effectKey(input, ctx, "task");
        if (seen.has(key)) return seen.get(key);
        const summary = String((ctx.extract as any)?.actionItems?.[0] ?? "follow up");
        const ticket = { id: `TASK-${tickets.length + 1}`, summary, target: "jira" };
        tickets.push(ticket);
        seen.set(key, ticket);
        return ticket;
      }
    },
    notifiers: {
      slack: (input: Record<string, unknown>, ctx: RunContext) => {
        const key = effectKey(input, ctx, "notify");
        if (seen.has(key)) return seen.get(key);
        const decision = String((ctx.extract as any)?.decisions?.[0] ?? "(none)");
        const msg = { channel: "#team-updates", text: `New decision recorded: ${decision}` };
        slack.push(msg);
        seen.set(key, msg);
        return msg;
      }
    }
  };
}
