/**
 * Real agent provider behind the workflow-engine's `AgentHandler` seam
 * (ADR-0002). Uses the Anthropic SDK when ANTHROPIC_API_KEY is set; otherwise a
 * deterministic mock so local/CI runs need no secret. Real token usage is
 * returned so governance.chargeModelUsage meters and hard-stops on budget.
 *
 * T3.1 (provider) + T3.2 (flagship extraction prompt/schema) refine this; the
 * seam and structured-output contract live here.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AgentHandler, RunContext } from "@companyos/workflow-engine";

/** JSON schema for the flagship meeting extraction (decisions/risks/etc + citations). */
export const EXTRACT_MEETING_SCHEMA = {
  type: "object",
  required: ["title", "customer", "decisions", "risks", "customerFacts", "actionItems", "confidence", "citations"],
  properties: {
    title: { type: "string" },
    customer: { type: "string" },
    customerSensitive: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    decisions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    customerFacts: { type: "array", items: { type: "string" } },
    actionItems: { type: "array", items: { type: "string" } },
    // Each claim should cite the brain context (by id/title) that grounds it.
    citations: { type: "array", items: { type: "string" } }
  }
} as const;

const EXTRACT_SYSTEM = `You turn a meeting transcript into structured, grounded company memory.
Extract decisions, risks, customer facts, and action items. Every non-trivial
claim must be supported by the transcript or the provided brain context; cite the
supporting context in "citations". Do not invent facts. If the meeting concerns a
specific customer's commercial terms, set customerSensitive=true. "confidence" is
your calibrated confidence (0..1) that the extraction is faithful.`;

export interface AgentProviderOptions {
  apiKey?: string;
  /** Default model for the flagship extraction agent (intelligence-sensitive). */
  extractionModel?: string;
}

function ctxText(ctx: RunContext): string {
  return String((ctx.clean as any)?.text ?? (ctx.input as any)?.transcript ?? "");
}

function brainContext(ctx: RunContext): string {
  const hits = (ctx.context as any) ?? (ctx.input as any)?.context;
  if (!Array.isArray(hits)) return "";
  return hits
    .map((h: any) => `- [${h.id ?? h.title ?? "ctx"}] ${h.title ?? ""}: ${String(h.content ?? h.snippet ?? "").slice(0, 400)}`)
    .join("\n");
}

/** Deterministic fallback used when no API key is configured (keeps demo + tests runnable). */
function mockExtract(ctx: RunContext) {
  const t = ctxText(ctx);
  return {
    output: {
      title: "Globex — Q3 renewal",
      customer: "Globex",
      customerSensitive: true,
      confidence: 0.9,
      decisions: ["prioritize SSO for the August release"],
      risks: ["SSO slipping past August may delay Globex expansion"],
      customerFacts: ["Globex expansion budget approved at 250 seats"],
      actionItems: ["Bob to scope SSO work and open a Jira ticket"],
      citations: ["icp", "sso-epic"],
      transcriptLen: t.length
    },
    model: "mock",
    inputTokens: Math.ceil(t.length / 4),
    outputTokens: 180
  };
}

export function createAgentHandlers(opts: AgentProviderOptions = {}): Record<string, AgentHandler> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = opts.extractionModel ?? "claude-opus-4-8";

  const extract_meeting: AgentHandler = async (ctx) => {
    if (!apiKey) return mockExtract(ctx);
    const client = new Anthropic({ apiKey, maxRetries: 3 });
    const transcript = ctxText(ctx);
    const context = brainContext(ctx);
    const msg = await client.messages.create({
      model,
      max_tokens: 2048,
      system: EXTRACT_SYSTEM,
      tool_choice: { type: "tool", name: "record_extraction" },
      tools: [
        {
          name: "record_extraction",
          description: "Record the structured meeting extraction.",
          input_schema: EXTRACT_MEETING_SCHEMA as any
        }
      ],
      messages: [
        {
          role: "user",
          content:
            (context ? `Relevant company brain context:\n${context}\n\n` : "") +
            `Meeting transcript:\n${transcript}`
        }
      ]
    });
    const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const output = (toolUse?.input as Record<string, unknown>) ?? {};
    return {
      output,
      model: msg.model,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens
    };
  };

  return { extract_meeting };
}
