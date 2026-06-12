/**
 * JiraClient (T4.6 outbound)
 *
 * Real Jira Cloud create-issue client via fetch (REST API v3).
 *
 * Mirrors SlackNotifier's design properties:
 * 1. Idempotency: a caller-supplied idempotencyKey makes a replay of the same
 *    logical effect (a retried workflow node) a no-op that returns the cached
 *    result. The seen-keys map is in-memory; durable idempotency across restarts
 *    is the workflow engine's run_steps key (W1/T1.3).
 * 2. Token injection: the API token + email are passed at construction and are
 *    NEVER logged. Auth is HTTP Basic (`email:apiToken`) per Atlassian Cloud.
 * 3. fetch injection: tests provide a mock fetch; production uses globalThis.fetch.
 * 4. Error transparency: non-ok responses throw so the engine can retry/escalate.
 */

/** Base64 that works in node (Buffer) and the browser (btoa). */
function base64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(s)));
}

export interface JiraClientConfig {
  /** Site base URL, e.g. https://your-org.atlassian.net (no trailing slash). */
  baseUrl: string;
  /** Atlassian account email for Basic auth. */
  email: string;
  /** Atlassian API token. NEVER log this. */
  apiToken: string;
  /** Project key new issues are created under, e.g. "OPS". */
  projectKey: string;
  /** Issue type name; defaults to "Task". */
  issueType?: string;
}

export interface CreateIssueParams {
  summary: string;
  /** Optional plain-text description. */
  description?: string;
  /**
   * Caller-assigned idempotency key. If an issue with this key was already
   * created successfully, the call is a no-op and the cached result returns.
   * Recommended: `${runId}:${stepId}:jira_create`.
   */
  idempotencyKey: string;
}

export interface CreateIssueResult {
  /** Jira issue key, e.g. "OPS-123". */
  key: string;
  /** Jira internal issue id. */
  id: string;
  /** True if this was a no-op replay (key seen; no HTTP call made). */
  cached: boolean;
}

interface JiraCreateIssueResponse {
  id?: string;
  key?: string;
  errorMessages?: string[];
}

export class JiraClient {
  private readonly created = new Map<string, CreateIssueResult>();
  private readonly fetchFn: typeof fetch;
  private readonly issueType: string;

  constructor(
    private readonly config: JiraClientConfig,
    fetchFn?: typeof fetch
  ) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.issueType = config.issueType ?? "Task";
  }

  /**
   * Create a Jira issue. Idempotent on idempotencyKey: the first call posts and
   * caches the result; subsequent calls with the same key return the cache with
   * no HTTP request.
   */
  async createIssue(params: CreateIssueParams): Promise<CreateIssueResult> {
    const prior = this.created.get(params.idempotencyKey);
    if (prior !== undefined) return { ...prior, cached: true };

    const body = {
      fields: {
        project: { key: this.config.projectKey },
        summary: params.summary,
        issuetype: { name: this.issueType },
        ...(params.description
          ? {
              description: {
                type: "doc",
                version: 1,
                content: [
                  { type: "paragraph", content: [{ type: "text", text: params.description }] }
                ]
              }
            }
          : {})
      }
    };

    const auth = base64(`${this.config.email}:${this.config.apiToken}`);
    const res = await this.fetchFn(`${this.config.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`jira: HTTP error ${res.status} creating issue in ${this.config.projectKey}`);
    }
    const data = (await res.json()) as JiraCreateIssueResponse;
    if (!data.key || !data.id) {
      const why = data.errorMessages?.join("; ") ?? "missing key/id";
      throw new Error(`jira: create-issue failed (${why})`);
    }

    const result: CreateIssueResult = { key: data.key, id: data.id, cached: false };
    this.created.set(params.idempotencyKey, result);
    return result;
  }

  hasCreated(idempotencyKey: string): boolean {
    return this.created.has(idempotencyKey);
  }

  get createdCount(): number {
    return this.created.size;
  }
}
