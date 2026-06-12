/**
 * Entity/relation extractor for the temporal memory graph (FR-3.3).
 *
 * Real path: an Anthropic-backed extractor (gated on ANTHROPIC_API_KEY) that
 * pulls typed entities + subject/predicate/object facts from a document. Offline
 * fallback: the deterministic proper-noun extractor in @companyos/brain. The
 * Anthropic dependency stays in core (server-only) so the brain package and the
 * browser bundle never pull the SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DeterministicExtractor, type EntityExtractor, type Extraction } from "@companyos/brain";

const EXTRACT_SCHEMA = {
  type: "object",
  required: ["entities", "edges"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "type"],
        properties: {
          name: { type: "string" },
          type: { type: "string", description: "person | org | project | product | topic | ..." }
        }
      }
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        required: ["subject", "predicate", "object"],
        properties: {
          subject: { type: "string", description: "entity name" },
          predicate: { type: "string", description: "relationship, e.g. works_on, decided, owns, blocks" },
          object: { type: "string", description: "entity name or short literal" }
        }
      }
    }
  }
} as const;

const SYSTEM = `Extract a knowledge graph from the text. Identify the salient entities
(people, orgs, projects, products, topics) with a short type, and the factual
relationships between them as subject/predicate/object triples. Use entity names
exactly as they appear. Do not invent facts not supported by the text.`;

export function createEntityExtractor(opts: { apiKey?: string; model?: string } = {}): EntityExtractor {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const deterministic = new DeterministicExtractor();
  if (!apiKey) return deterministic;
  const model = opts.model ?? "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async extract(text: string): Promise<Extraction> {
      try {
        const msg = await client.messages.create({
          model,
          max_tokens: 1024,
          system: SYSTEM,
          tool_choice: { type: "tool", name: "record_graph" },
          tools: [{ name: "record_graph", description: "Record the extracted entities + facts.", input_schema: EXTRACT_SCHEMA as any }],
          messages: [{ role: "user", content: text.slice(0, 12000) }]
        });
        const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        const out = (tool?.input as Partial<Extraction>) ?? {};
        return {
          entities: Array.isArray(out.entities) ? out.entities : [],
          edges: Array.isArray(out.edges) ? out.edges : []
        };
      } catch {
        // Fail soft to the deterministic extractor on any model error.
        return deterministic.extract(text);
      }
    }
  };
}
