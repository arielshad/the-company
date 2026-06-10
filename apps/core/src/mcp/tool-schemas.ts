/**
 * Minimal JSON input schemas advertised over MCP `tools/list`.
 *
 * The gateway's catalog (apps/gateway) only carries name + description; MCP
 * clients want an `inputSchema` so they can construct valid `tools/call`
 * arguments. We mirror the argument shapes the gateway handlers read (see
 * `McpGateway.buildCatalog`) — kept deliberately permissive (extra props
 * allowed) since the gateway is the authority on validation/authorization.
 *
 * Unknown tools fall back to a permissive object schema so a future tool added
 * to the catalog is still callable before its schema lands here.
 */
export type JsonSchema = {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
};

const SCHEMAS: Record<string, JsonSchema> = {
  "brain.search": {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language search over the permission-aware brain" },
      topK: { type: "integer", minimum: 1, description: "Max results to return" }
    },
    required: ["query"],
    additionalProperties: false
  },
  "brain.write": {
    type: "object",
    properties: {
      type: { type: "string", description: "Memory object type, e.g. 'decision'" },
      title: { type: "string" },
      content: { type: "string" },
      source: {
        type: "object",
        properties: { connector: { type: "string" }, externalId: { type: "string" }, url: { type: "string" } }
      },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["title", "content"],
    additionalProperties: true
  },
  "skill.run": {
    type: "object",
    properties: {
      skillId: { type: "string", description: "Id of a registered, active skill" },
      input: { type: "object", description: "Skill input payload" }
    },
    required: ["skillId"],
    additionalProperties: true
  },
  "workflow.trigger": {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "Id of a published workflow" },
      data: { type: "object", description: "Trigger payload passed to the run" }
    },
    required: ["workflowId"],
    additionalProperties: true
  }
};

const FALLBACK: JsonSchema = { type: "object", additionalProperties: true };

export function inputSchemaFor(toolName: string): JsonSchema {
  return SCHEMAS[toolName] ?? FALLBACK;
}
