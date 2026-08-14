import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../config.js";
import { log } from "../logger.js";

export type Db = Database.Database;

let cached: Db | null = null;

/**
 * Walks up from this module until it finds `migrations/`, so the same code
 * works whether it is running from `src/` under tsx or from `dist/src/` in the
 * container — the two are at different depths.
 */
function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the migrations directory; set MIGRATIONS_DIR"
  );
}

/**
 * Applies every migrations/NNNN_*.sql not yet recorded, in filename order,
 * each in its own transaction. Migrations that have shipped are never edited —
 * the container applies them on boot, so an upgrade is one step for the
 * operator, and editing one means the hosts that already ran it diverge.
 */
function migrate(db: Db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  );
  const applied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name)
  );
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)"
      ).run(file, new Date().toISOString());
    })();
    log.info("migration applied", { file });
  }
}

export function db(): Db {
  if (cached) return cached;
  const dir = resolve(dataDir());
  mkdirSync(dir, { recursive: true });
  const conn = new Database(join(dir, "hawk-bot.db"));
  conn.pragma("journal_mode = WAL");
  // SQLite needs this per-connection or the ON DELETE CASCADEs silently do
  // nothing.
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  migrate(conn);
  cached = conn;
  return conn;
}
