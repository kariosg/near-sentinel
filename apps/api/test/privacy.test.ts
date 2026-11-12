import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, hashIp, openDb, prune } from "../src/db.js";
import { loadEnv } from "../src/env.js";

type Row = { id: number; at: string; ip: string | null };

describe("audit log privacy", () => {
  it("stores a salted hash, never the raw IP", () => {
    const db = openDb(":memory:");
    audit(db, { requestId: "r1", ip: "203.0.113.7", action: "test", outcome: "ok" });
    const row = db.prepare("SELECT ip FROM audit_log").get() as Row;
    expect(row.ip).not.toContain("203.0.113.7");
    expect(row.ip).toMatch(/^h:[0-9a-f]{16}$/);
  });

  it("gives the same hash for the same IP within a process, and different hashes for different IPs", () => {
    expect(hashIp("203.0.113.7")).toBe(hashIp("203.0.113.7"));
    expect(hashIp("203.0.113.7")).not.toBe(hashIp("203.0.113.8"));
    expect(hashIp(undefined)).toBeNull();
    expect(hashIp("")).toBeNull();
    expect(hashIp("h:0123456789abcdef")).toBe("h:0123456789abcdef");
  });

  it("stores null when there is no IP", () => {
    const db = openDb(":memory:");
    audit(db, { action: "test", outcome: "ok" });
    expect((db.prepare("SELECT ip FROM audit_log").get() as Row).ip).toBeNull();
  });

  it("prune removes audit rows older than 30 days and keeps recent ones", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const ins = db.prepare("INSERT INTO audit_log (at, ip, action, outcome) VALUES (?, ?, 'test', 'ok')");
    ins.run(new Date(now - 31 * 864e5).toISOString(), "h:old");
    ins.run(new Date(now - 1 * 864e5).toISOString(), "h:new");
    prune(db, now);
    const rows = db.prepare("SELECT ip FROM audit_log").all() as Row[];
    expect(rows.map((r) => r.ip)).toEqual(["h:new"]);
  });

  it("migration pass converts raw IPs already on disk to hashes without deleting rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-privacy-"));
    try {
      const file = join(dir, "t.db");
      const db1 = openDb(file);
      db1.prepare("INSERT INTO audit_log (at, ip, action, outcome) VALUES (?, ?, 'legacy', 'ok')").run(new Date().toISOString(), "198.51.100.4");
      db1.prepare("INSERT INTO audit_log (at, ip, action, outcome) VALUES (?, NULL, 'legacy', 'ok')").run(new Date().toISOString());
      db1.close();

      const db2 = openDb(file);
      const rows = db2.prepare("SELECT ip FROM audit_log ORDER BY id").all() as Row[];
      expect(rows).toHaveLength(2);
      expect(rows[0]!.ip).toBe(hashIp("198.51.100.4"));
      expect(rows[1]!.ip).toBeNull();
      const idx = db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='audit_log_at'").get();
      expect(idx).toBeTruthy();
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AUDIT_IP_SALT is optional but must be at least 16 characters when set", () => {
    expect(loadEnv({}).AUDIT_IP_SALT).toBeUndefined();
    expect(loadEnv({ AUDIT_IP_SALT: "" }).AUDIT_IP_SALT).toBeUndefined();
    expect(loadEnv({ AUDIT_IP_SALT: "x".repeat(16) }).AUDIT_IP_SALT).toBe("x".repeat(16));
    expect(() => loadEnv({ AUDIT_IP_SALT: "short" })).toThrow(/AUDIT_IP_SALT/);
  });
});
