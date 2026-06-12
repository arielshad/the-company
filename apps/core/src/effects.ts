/**
 * Outbound-effect seam: `task` (Jira) and `notify` (Slack) handlers.
 *
 * Real path (default in prod): when a `SlackNotifier` / `JiraClient` is wired
 * (secret present), the effect fires the real API call. The handler ALSO records
 * the outcome to an in-process ledger (`tickets` / `slack`) that the run
 * inspector and tests read — this ledger is an audit mirror, not a substitute
 * for the real call. When no client is configured (offline CI / local dev), the
 * handler is capture-only so the flagship thread still runs network-free.
 *
 * All effects run BEHIND the approval gate in the engine, and are deduped per
 * (meeting, node) so a replay does not double-fire.
 */
import type { TaskFn, NotifyFn, RunContext } from "@companyos/workflow-engine";
import { SlackNotifier, JiraClient } from "@companyos/connectors";

export interface CapturedTicket { id: string; summary: string; target: string }
export interface CapturedSlack { channel: string; text: string }

export interface EffectHandlers {
  tasks: Record<string, TaskFn>;
  notifiers: Record<string, NotifyFn>;
  tickets: CapturedTicket[];
  slack: CapturedSlack[];
}

/** Real clients to fire effects against; any omitted ⇒ capture-only for it. */
export interface EffectClients {
  slack?: SlackNotifier;
  /** Default Slack channel when a notify node doesn't specify one. */
  slackChannel?: string;
  jira?: JiraClient;
}

/** Stable idempotency key for an effect node within a run (dedupes replays). */
function effectKey(input: Record<string, unknown>, ctx: RunContext, kind: string): string {
  const subject = String((ctx.input as any)?.meetingId ?? (ctx.input as any)?.id ?? "run");
  return `${kind}:${subject}:${String((input as any)?.id ?? kind)}`;
}

/**
 * Build effect handlers. Pass real clients to fire real API calls; omit them
 * (the default) for capture-only behaviour in tests/dev.
 */
export function createEffects(clients: EffectClients = {}): EffectHandlers {
  const tickets: CapturedTicket[] = [];
  const slack: CapturedSlack[] = [];
  // Idempotency ledger: an effect key maps to its first result, so a replayed
  // step returns the prior result instead of firing the side effect again.
  const seen = new Map<string, unknown>();
  return {
    tickets,
    slack,
    tasks: {
      create_tickets: async (input: Record<string, unknown>, ctx: RunContext) => {
        const key = effectKey(input, ctx, "task");
        if (seen.has(key)) return seen.get(key);
        const summary = String((ctx.extract as any)?.actionItems?.[0] ?? "follow up");
        let ticket: CapturedTicket;
        if (clients.jira) {
          const res = await clients.jira.createIssue({ summary, idempotencyKey: key });
          ticket = { id: res.key, summary, target: "jira" };
        } else {
          ticket = { id: `TASK-${tickets.length + 1}`, summary, target: "jira" };
        }
        tickets.push(ticket);
        seen.set(key, ticket);
        return ticket;
      }
    },
    notifiers: {
      slack: async (input: Record<string, unknown>, ctx: RunContext) => {
        const key = effectKey(input, ctx, "notify");
        if (seen.has(key)) return seen.get(key);
        const decision = String((ctx.extract as any)?.decisions?.[0] ?? "(none)");
        const channel = String((input as any)?.channel ?? clients.slackChannel ?? "#team-updates");
        const text = `New decision recorded: ${decision}`;
        if (clients.slack) {
          await clients.slack.postMessage({ channel, text, idempotencyKey: key });
        }
        const msg = { channel, text };
        slack.push(msg);
        seen.set(key, msg);
        return msg;
      }
    }
  };
}

/** Back-compat: capture-only effects (no real clients). */
export function createInMemoryEffects(): EffectHandlers {
  return createEffects();
}

/** Build real-or-capture effect clients from runtime config. */
export function effectClientsFromConfig(config: {
  slack?: { botToken: string; defaultChannel: string };
  jira?: { baseUrl: string; email: string; apiToken: string; projectKey: string; issueType?: string };
}): EffectClients {
  return {
    slack: config.slack ? new SlackNotifier(config.slack.botToken) : undefined,
    slackChannel: config.slack?.defaultChannel,
    jira: config.jira ? new JiraClient(config.jira) : undefined
  };
}
