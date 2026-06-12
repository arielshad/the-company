/**
 * Runtime configuration for `core` (the modular monolith). All knobs come from
 * the environment so the same image runs in local-dev (SQLite, no external
 * deps) and on the shep-infra platform (Postgres/pgvector + Keycloak + OpenFGA).
 * See docs/adr/0008.
 */

export type Persistence = "memory" | "sqlite" | "postgres";
export type AuthzBackend = "memory" | "sqlite" | "openfga";

export interface CoreConfig {
  port: number;
  host: string;
  /** Where relational + audit + memory state lives. */
  persistence: Persistence;
  /** SQLite file path when persistence/authz is "sqlite" (":memory:" allowed). */
  sqlitePath: string;
  /** Postgres DSN when persistence is "postgres". */
  databaseUrl?: string;
  /** Authorization decision point. */
  authzBackend: AuthzBackend;
  openfga?: { apiUrl: string; storeId?: string; modelId?: string };
  /** OIDC (Keycloak). When unset, dev auth is used. */
  oidc?: { issuer: string; clientId: string };
  /** Dev auth bypass: trust an x-dev-principal header. Never enable in prod. */
  devAuth: boolean;
  /** Anthropic API key for real agents/judges; absent ⇒ deterministic mock. */
  anthropicApiKey?: string;
  /** Outbound Slack (real chat.postMessage when set; else capture-only). */
  slack?: { botToken: string; defaultChannel: string };
  /** Outbound Jira (real create-issue when set; else capture-only). */
  jira?: { baseUrl: string; email: string; apiToken: string; projectKey: string; issueType?: string };
  /** Notion source connector OAuth config (read). Registered when set. */
  notion?: { clientId: string; clientSecret: string; redirectUri: string };
  /** Google Drive source connector OAuth config (read). */
  googleDrive?: { clientId: string; clientSecret: string; redirectUri: string };
  /** GitHub source connector OAuth config (read). */
  github?: { clientId: string; clientSecret: string; redirectUri: string };
  /** Gmail source connector OAuth config (read). */
  gmail?: { clientId: string; clientSecret: string; redirectUri: string };
  /** Google Calendar source connector OAuth config (read). */
  googleCalendar?: { clientId: string; clientSecret: string; redirectUri: string };
  /** Real embeddings via an OpenAI-compatible /v1/embeddings server; else bag-of-words. */
  embeddings?: { baseUrl: string; model: string; apiKey?: string };
  /** Default org for single-tenant MVP wiring + dev. */
  defaultOrg: string;
  appUrl: string;
}

function envBool(v: string | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

/** Read a `${PREFIX}_CLIENT_ID/SECRET/REDIRECT_URI` OAuth triple, or undefined. */
function oauthCfg(env: NodeJS.ProcessEnv, prefix: string) {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  const redirectUri = env[`${prefix}_REDIRECT_URI`];
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const databaseUrl = env.DATABASE_URL;
  const persistence: Persistence =
    (env.PERSISTENCE as Persistence) || (databaseUrl ? "postgres" : "sqlite");

  const openfgaApiUrl = env.OPENFGA_API_URL;
  const authzBackend: AuthzBackend =
    (env.AUTHZ_BACKEND as AuthzBackend) || (openfgaApiUrl ? "openfga" : persistence === "memory" ? "memory" : "sqlite");

  const issuer = env.AUTH_KEYCLOAK_ISSUER;
  // Dev auth is on by default unless a real OIDC issuer is configured.
  const devAuth = envBool(env.AUTH_DEV, !issuer);

  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    persistence,
    sqlitePath: env.SQLITE_PATH ?? (persistence === "sqlite" ? ".data/core.db" : ":memory:"),
    databaseUrl,
    authzBackend,
    openfga: openfgaApiUrl
      ? { apiUrl: openfgaApiUrl, storeId: env.OPENFGA_STORE_ID, modelId: env.OPENFGA_MODEL_ID }
      : undefined,
    oidc: issuer ? { issuer, clientId: env.AUTH_KEYCLOAK_ID ?? "the-company-web" } : undefined,
    devAuth,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    slack: env.SLACK_BOT_TOKEN
      ? { botToken: env.SLACK_BOT_TOKEN, defaultChannel: env.SLACK_DEFAULT_CHANNEL ?? "#team-updates" }
      : undefined,
    jira:
      env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN && env.JIRA_PROJECT_KEY
        ? {
            baseUrl: env.JIRA_BASE_URL.replace(/\/$/, ""),
            email: env.JIRA_EMAIL,
            apiToken: env.JIRA_API_TOKEN,
            projectKey: env.JIRA_PROJECT_KEY,
            issueType: env.JIRA_ISSUE_TYPE
          }
        : undefined,
    notion: oauthCfg(env, "NOTION"),
    googleDrive: oauthCfg(env, "GOOGLE_DRIVE"),
    github: oauthCfg(env, "GITHUB"),
    gmail: oauthCfg(env, "GMAIL"),
    googleCalendar: oauthCfg(env, "GOOGLE_CALENDAR"),
    embeddings:
      env.EMBEDDINGS_BASE_URL && env.EMBEDDINGS_MODEL
        ? { baseUrl: env.EMBEDDINGS_BASE_URL.replace(/\/$/, ""), model: env.EMBEDDINGS_MODEL, apiKey: env.EMBEDDINGS_API_KEY }
        : undefined,
    defaultOrg: env.DEFAULT_ORG ?? "acme",
    appUrl: env.APP_URL ?? "http://localhost:8080"
  };
}
