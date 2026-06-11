/**
 * Migration runner (T1.1). Applies `apps/core/migrations/*.sql` in lexical order
 * inside a transaction each, tracking applied files in a `schema_migrations`
 * table so re-runs are no-ops.
 *
 * Invocation:
 *   - dev / CI:  `pnpm --filter @companyos/core migrate`  (script: tsx src/db/migrate.ts)
 *   - k8s init:  bundled to migrate.mjs and run by an initContainer.
 *
 * Reads DATABASE_URL from the environment.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/db/migrate.ts → ../../migrations
export const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

function migrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 0001_*, 0002_* … lexical order is application order
}

/** Apply all pending migrations against an existing pool. Idempotent. */
export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of migrationFiles(dir)) {
    if (done.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = readFileSync(join(dir, name), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

/** Convenience entrypoint: build a pool from DATABASE_URL, migrate, close. */
export async function migrate(databaseUrl: string): Promise<MigrateResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

// Run when invoked directly (tsx src/db/migrate.ts or node migrate.mjs).
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required to run migrations.");
    process.exit(1);
  }
  migrate(databaseUrl)
    .then((r) => {
      console.log(`Migrations applied: ${r.applied.length ? r.applied.join(", ") : "(none)"}`);
      if (r.skipped.length) console.log(`Already applied: ${r.skipped.join(", ")}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
