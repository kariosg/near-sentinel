/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native addon, no server).
 * All SQL uses prepared statements with bound parameters — never string concatenation.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: Array<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
      CREATE TABLE provider_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        provider TEXT NOT NULL,
        operator TEXT NOT NULL,
        reachable INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        height INTEGER,
        lag INTEGER,
        error_kind TEXT
      );
      CREATE INDEX idx_samples_provider_at ON provider_samples(provider, at);

      CREATE TABLE incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE INDEX idx_incidents_open ON incidents(provider, kind, closed_at);

      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        verdict TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX idx_reports_tx ON reports(tx_hash, created_at);

      CREATE TABLE benchmark_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('real','simulated')),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        params TEXT NOT NULL,
        result TEXT
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        request_id TEXT,
        ip TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT
      );

      CREATE TABLE custom_providers (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        operator TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
    `,
  },
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export function audit(db: Db, e: { requestId?: string; ip?: string; action: string; outcome: string; detail?: unknown }): void {
  db.prepare("INSERT INTO audit_log (at, request_id, ip, action, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    e.requestId ?? null,
    e.ip ?? null,
    e.action,
    e.outcome,
    e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, 4000),
  );
}

/** Retention: keep raw samples 7 days, reports 30 days. */
export function prune(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM provider_samples WHERE at < ?").run(new Date(now - 7 * 864e5).toISOString());
  db.prepare("DELETE FROM reports WHERE created_at < ?").run(new Date(now - 30 * 864e5).toISOString());
}
