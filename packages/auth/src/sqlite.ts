import { createRequire } from "node:module";
import {
  AbstractAuthz,
  COMPANYOS_MODEL,
  type AuthzModel,
  type Tuple,
  type TupleStore
} from "./index.js";

// Loaded via createRequire so the bundler never tries to resolve node:sqlite
// (it is newer than some bundlers' builtin lists). Types are preserved.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
type DB = InstanceType<typeof DatabaseSync>;

/**
 * Durable SQLite-backed authorization store (node-only — uses node:sqlite).
 * Reuses the exact ReBAC algorithm from `runCheck`/`AbstractAuthz`, so its
 * semantics are identical to InMemoryAuthz; only tuple persistence differs.
 * Tuples survive process restarts (proven in sqlite.test.ts).
 */
interface Row {
  subject: string;
}

class SqliteTupleStore implements TupleStore {
  constructor(private db: DB) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS tuples (subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, PRIMARY KEY (subject, relation, object))"
    );
  }
  add(t: Tuple): void {
    this.db.prepare("INSERT OR IGNORE INTO tuples (subject, relation, object) VALUES (?, ?, ?)").run(t.subject, t.relation, t.object);
  }
  remove(t: Tuple): void {
    this.db.prepare("DELETE FROM tuples WHERE subject = ? AND relation = ? AND object = ?").run(t.subject, t.relation, t.object);
  }
  subjects(relation: string, object: string): string[] {
    const rows = this.db.prepare("SELECT subject FROM tuples WHERE relation = ? AND object = ?").all(relation, object) as unknown as Row[];
    return rows.map((r) => r.subject);
  }
}

export class SqliteAuthz extends AbstractAuthz {
  private db: DB;
  /** @param path file path for durability, or ":memory:" (default). */
  constructor(path = ":memory:", model: AuthzModel = COMPANYOS_MODEL) {
    const db = new DatabaseSync(path);
    super(new SqliteTupleStore(db), model);
    this.db = db;
  }
  close(): void {
    this.db.close();
  }
}
