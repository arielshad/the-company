-- =============================================================================
-- 0001_init.sql — the_company core schema (T1.1)
--
-- Target: the shared CloudNativePG `the_company` database (ADR-0008). One logical
-- DB holds relational + vector data. Every tenant-scoped table carries
-- `org_id text not null` and is protected by Row-Level Security (RLS) keyed on
-- the `app.org_id` GUC (NFR-2 tenant isolation). The application sets this GUC
-- per-transaction via `SET LOCAL app.org_id = '<org>'` (see src/db/pool.ts:withOrg).
--
-- Conventions:
--   * timestamps are `timestamptz`, defaulting to now().
--   * JSON blobs are `jsonb`.
--   * pgvector embeddings use 1536 dims (see memory_items.embedding) — the default
--     output width of the planned embeddings model (T3.3). Configurable only by a
--     follow-up migration since the column type is fixed-width.
--   * This migration is written to be idempotent (IF NOT EXISTS) where reasonable
--     so the runner can re-apply safely during local iteration.
-- =============================================================================

-- pgvector. On the platform the extension is enabled via the CNPG image
-- (ADR-0008 required action #5). Guarded so a DB that already has it is a no-op;
-- if the image lacks the extension this statement fails loudly (correct — the
-- platform contract is unmet).
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- orgs — the tenant root. NOT itself org-scoped (it *is* the org), but we still
-- enable RLS so a session may only see its own org row.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orgs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- -----------------------------------------------------------------------------
-- users — members of an org. Identity comes from Keycloak (W2); this row mirrors
-- the principal for joins/audit, it is not the auth source of truth.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          text NOT NULL,
  org_id      text NOT NULL,
  email       text NOT NULL,
  name        text,
  roles       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_org_email_idx ON users (org_id, lower(email));

-- -----------------------------------------------------------------------------
-- agents — registered agents (agent-registry).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id            text NOT NULL,
  org_id        text NOT NULL,
  name          text NOT NULL,
  role          text,
  model         text,
  budget_cap    numeric(12,4),
  spec          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents (org_id);

-- -----------------------------------------------------------------------------
-- skills — promoted skills (skill-registry).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skills (
  id            text NOT NULL,
  org_id        text NOT NULL,
  name          text NOT NULL,
  owner         text,
  status        text NOT NULL DEFAULT 'draft',
  version       text NOT NULL DEFAULT '0.1.0',
  spec          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS skills_org_idx ON skills (org_id);

-- -----------------------------------------------------------------------------
-- workflows + workflow_versions — definitions are versioned; runs reference a
-- specific version for reproducibility.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
  id            text NOT NULL,
  org_id        text NOT NULL,
  name          text NOT NULL,
  current_version text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS workflows_org_idx ON workflows (org_id);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id            text NOT NULL,
  org_id        text NOT NULL,
  workflow_id   text NOT NULL,
  version       text NOT NULL,
  graph         jsonb NOT NULL,          -- the compiled DSL graph
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS workflow_versions_org_wf_idx ON workflow_versions (org_id, workflow_id);

-- -----------------------------------------------------------------------------
-- runs + run_steps — durable workflow execution (T1.3). State must survive a
-- crash; run_steps carry per-node input/output/cost/timing for the inspector
-- (FR-6.7) and an idempotency key so a replayed external-effect step does not
-- double-send (dedupe on (org_id, idempotency_key)).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id                text NOT NULL,
  org_id            text NOT NULL,
  workflow_id       text,
  workflow_version  text,
  status            text NOT NULL DEFAULT 'pending',  -- pending|running|paused|completed|failed
  trace_id          text,
  input             jsonb NOT NULL DEFAULT '{}'::jsonb,
  output            jsonb,
  cost_usd          numeric(12,6) NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS runs_org_idx ON runs (org_id);
CREATE INDEX IF NOT EXISTS runs_org_status_idx ON runs (org_id, status);

CREATE TABLE IF NOT EXISTS run_steps (
  id                text NOT NULL,
  org_id            text NOT NULL,
  run_id            text NOT NULL,
  node_id           text NOT NULL,
  seq               integer NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  idempotency_key   text,                 -- per external-effect step; dedupe replays
  input             jsonb,
  output            jsonb,
  cost_usd          numeric(12,6) NOT NULL DEFAULT 0,
  started_at        timestamptz,
  finished_at       timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS run_steps_org_run_idx ON run_steps (org_id, run_id, seq);
-- Idempotency guard: a given external effect fires at most once per org.
CREATE UNIQUE INDEX IF NOT EXISTS run_steps_idempotency_idx
  ON run_steps (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- approvals — human-in-the-loop gates that pause a run.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id            text NOT NULL,
  org_id        text NOT NULL,
  run_id        text,
  step_id       text,
  status        text NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  reason        text,
  requested_by  text,
  decided_by    text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS approvals_org_status_idx ON approvals (org_id, status);

-- -----------------------------------------------------------------------------
-- memory_items — the Company Brain store (T3.3). Mirrors BrainItem.
--   * `source` / `source_acl` / `visibility` / `related_people` are jsonb so the
--     adapter round-trips the exact shapes from @companyos/brain.
--   * `connector` + `external_id` are denormalized out of `source` for the
--     (org_id, connector, external_id) uniqueness used by idempotent ingest.
--   * `embedding vector(1536)` is NULLABLE — bag-of-words remains the offline
--     default; embeddings are backfilled by T3.3 via the Embedder seam.
--   * `search_tsv` is a generated tsvector for keyword retrieval.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_items (
  id            text NOT NULL,
  org_id        text NOT NULL,
  kind          text NOT NULL,
  type          text NOT NULL,
  title         text NOT NULL,
  content       text NOT NULL,
  source        jsonb NOT NULL,
  source_acl    jsonb,
  confidence    double precision NOT NULL DEFAULT 1,
  timestamp     text NOT NULL,            -- ISO8601 string, preserved verbatim from BrainItem
  visibility    jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_people jsonb,
  superseded_by text,
  expires_at    text,
  connector     text NOT NULL,
  external_id   text NOT NULL,
  embedding     vector(1536),             -- T3.3 seam; NULL until embedded
  search_tsv    tsvector GENERATED ALWAYS AS (
                  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS memory_items_org_idx ON memory_items (org_id);
-- Idempotent ingest key (brain.ingest dedupes on connector+externalId per org).
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_source_uq
  ON memory_items (org_id, connector, external_id);
-- Keyword retrieval.
CREATE INDEX IF NOT EXISTS memory_items_tsv_idx ON memory_items USING gin (search_tsv);
-- Approximate-nearest-neighbour over embeddings. ivfflat needs ANALYZE/data to
-- build well; lists=100 is a reasonable default for the MVP corpus size. Uses
-- cosine distance to match the brain's cosine scoring.
CREATE INDEX IF NOT EXISTS memory_items_embedding_idx
  ON memory_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- -----------------------------------------------------------------------------
-- memory_lineage — data lineage edges (FR-8.6): a derived memory back to the
-- source items / ingestion run that produced it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_lineage (
  id              text NOT NULL,
  org_id          text NOT NULL,
  memory_id       text NOT NULL,
  parent_id       text,            -- upstream memory_item, if derived from another
  ingestion_run_id text,
  relation        text NOT NULL DEFAULT 'derived_from',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS memory_lineage_org_mem_idx ON memory_lineage (org_id, memory_id);

-- -----------------------------------------------------------------------------
-- audit_log — append-only, immutable (FR-8.4). No UPDATE/DELETE is ever issued
-- by the adapter, and RLS below grants no such rights to the app role. `seq` is
-- a per-table monotonic ordering; the per-org tamper-evident FNV-1a chain is
-- materialized in `row_digest` (rolling) so it can be re-derived/verified across
-- a process restart without replaying application state.
--   row_digest = fnv1a(prev_org_digest + canonical_json(AuditRecord))
-- where canonical_json matches @companyos/telemetry InMemoryAudit's
-- JSON.stringify of the AuditRecord (field order: id, orgId, ts, actor, action,
-- resource, traceId, costUsd?, decision?, metadata).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  seq           bigserial,
  id            text NOT NULL,
  org_id        text NOT NULL,
  ts            text NOT NULL,           -- ISO8601 from AuditRecord.ts, verbatim
  actor_type    text NOT NULL,
  actor_id      text NOT NULL,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text NOT NULL,
  trace_id      text NOT NULL,
  cost_usd      double precision,
  decision      text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_digest    text NOT NULL,           -- rolling per-org FNV-1a chain value at this row
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, seq)
);
CREATE INDEX IF NOT EXISTS audit_log_org_seq_idx ON audit_log (org_id, seq);

-- -----------------------------------------------------------------------------
-- budget_ledger — per-agent/org spend entries (NFR-9). Append-only ledger; the
-- BudgetTracker sums these.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_ledger (
  id            text NOT NULL,
  org_id        text NOT NULL,
  agent_id      text,
  run_id        text,
  model         text,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX IF NOT EXISTS budget_ledger_org_agent_idx ON budget_ledger (org_id, agent_id);

-- -----------------------------------------------------------------------------
-- connector_tokens — OAuth credentials for connectors. CRITICAL: stores only a
-- *secret reference* (e.g. an Infisical/ESO path or external secret name), NEVER
-- a raw access/refresh token. The raw material lives in Infisical (ADR-0008).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_tokens (
  id            text NOT NULL,
  org_id        text NOT NULL,
  connector     text NOT NULL,
  account_ref   text,                    -- which external account/workspace
  secret_ref    text NOT NULL,           -- pointer into Infisical/ESO; NOT the token
  scopes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'connected',
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_tokens_uq
  ON connector_tokens (org_id, connector, coalesce(account_ref, ''));

-- -----------------------------------------------------------------------------
-- oauth_state — short-lived CSRF/PKCE state for the OAuth auth-code dance.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_state (
  state         text NOT NULL,
  org_id        text NOT NULL,
  connector     text NOT NULL,
  code_verifier text,                    -- PKCE verifier (transient)
  redirect_uri  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (org_id, state)
);
CREATE INDEX IF NOT EXISTS oauth_state_expiry_idx ON oauth_state (expires_at);

-- =============================================================================
-- Row-Level Security (NFR-2)
--
-- Every tenant table restricts visibility to the current session's org, read
-- from the `app.org_id` GUC. The application opens a transaction and runs
-- `SET LOCAL app.org_id = '<org>'` (src/db/pool.ts:withOrg) before any query, so
-- a missing/empty GUC yields zero rows (fail-closed). audit_log additionally has
-- NO update/delete policy → it is append-only at the row-security layer too.
--
-- `current_setting('app.org_id', true)` — the `true` (missing_ok) arg returns
-- NULL instead of erroring when the GUC is unset, which the policies treat as
-- "no org" (no rows).
-- =============================================================================

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'orgs','users','agents','skills','workflows','workflow_versions',
    'runs','run_steps','approvals','memory_items','memory_lineage',
    'budget_ledger','connector_tokens','oauth_state'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- orgs keys on `id`; every other tenant table keys on `org_id`.
    IF t = 'orgs' THEN
      EXECUTE format($q$
        DROP POLICY IF EXISTS %1$s_isolation ON %1$I;
        CREATE POLICY %1$s_isolation ON %1$I
          USING (id = current_setting('app.org_id', true))
          WITH CHECK (id = current_setting('app.org_id', true));
      $q$, t);
    ELSE
      EXECUTE format($q$
        DROP POLICY IF EXISTS %1$s_isolation ON %1$I;
        CREATE POLICY %1$s_isolation ON %1$I
          USING (org_id = current_setting('app.org_id', true))
          WITH CHECK (org_id = current_setting('app.org_id', true));
      $q$, t);
    END IF;
  END LOOP;

  -- audit_log: SELECT + INSERT only (immutable). It is not in the loop above, so
  -- we enable RLS here and define per-command policies (no UPDATE/DELETE policy).
  EXECUTE 'ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE audit_log FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS audit_log_select ON audit_log';
  EXECUTE 'DROP POLICY IF EXISTS audit_log_insert ON audit_log';
  EXECUTE $q$
    CREATE POLICY audit_log_select ON audit_log FOR SELECT
      USING (org_id = current_setting('app.org_id', true))
  $q$;
  EXECUTE $q$
    CREATE POLICY audit_log_insert ON audit_log FOR INSERT
      WITH CHECK (org_id = current_setting('app.org_id', true))
  $q$;
  -- No UPDATE/DELETE policy → those commands are denied for non-owner roles.
END
$$;
