/**
 * Background provider prober.
 *  - health (status) every PROBE_INTERVAL_MS, full capability probe every CAPABILITY_INTERVAL_MS
 *  - every sample is persisted (provider_samples)
 *  - incidents are opened/closed automatically, but only after 2 consecutive bad samples, so a
 *    single transient failure never marks a provider as down.
 */
import { EventEmitter } from "node:events";
import type { ProviderHealth } from "@near-sentinel/sdk";
import { prune } from "./db.js";
import type { HealthSnapshot, Runtime } from "./runtime.js";

export const CONSECUTIVE_TO_OPEN = 2;

type IncidentKind = "PROVIDER_DOWN" | "PROVIDER_LAGGING" | "WRONG_CHAIN" | "CAPABILITY_CHANGED";

export class Prober extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private lastCaps = new Map<string, string>();
  private lastCapsAt = 0;
  private streak = new Map<string, number>(); // `${provider}:${kind}` → consecutive bad samples
  private running = false;

  constructor(private readonly rt: Runtime) {
    super();
    this.setMaxListeners(1000);
  }

  start(): void {
    const tick = () => {
      this.runOnce()
        .catch((e) => this.emit("error", e))
        .finally(() => {
          if (this.timer !== undefined) this.timer = setTimeout(tick, this.rt.env.PROBE_INTERVAL_MS);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Probe all providers once. Concurrent callers share the in-flight probe; they never receive
   * an undefined snapshot (bug found on cold start: the first API request raced the first probe).
   */
  runOnce(now = Date.now()): Promise<HealthSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.probe(now).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private inflight?: Promise<HealthSnapshot>;

  private async probe(now: number): Promise<HealthSnapshot> {
    this.running = true;
    try {
      const withCaps = now - this.lastCapsAt >= this.rt.env.CAPABILITY_INTERVAL_MS;
      const health = await this.rt.sentinel.getProviderHealth({ capabilities: withCaps });
      if (withCaps) this.lastCapsAt = now;
      // Keep the last known capabilities when this round did not probe them.
      const prevCaps = new Map(this.rt.lastHealth?.providers.map((p) => [p.provider, p.capabilities]));
      const snapshot: HealthSnapshot = {
        checkedAt: new Date(now).toISOString(),
        providers: health.map(({ observations: _o, ...p }) => ({
          ...p,
          capabilities: withCaps ? p.capabilities : (prevCaps.get(p.provider) ?? p.capabilities),
        })),
      };
      this.persist(health, snapshot.checkedAt);
      this.evaluate(health, snapshot.checkedAt, withCaps);
      this.rt.lastHealth = snapshot;
      if (now % (60 * 60_000) < this.rt.env.PROBE_INTERVAL_MS) prune(this.rt.db, now);
      this.emit("health", snapshot);
      return snapshot;
    } finally {
      this.running = false;
    }
  }

  private persist(health: ProviderHealth[], at: string): void {
    const stmt = this.rt.db.prepare(
      "INSERT INTO provider_samples (at, provider, operator, reachable, latency_ms, height, lag, error_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const p of health) {
      stmt.run(at, p.provider, p.operator, p.reachable ? 1 : 0, p.latencyMs, p.latestBlockHeight ?? null, p.heightLag ?? null, p.error?.kind ?? null);
    }
  }

  private openIncident(provider: string, kind: IncidentKind, severity: string, summary: string, evidence: unknown, at: string, closeNow = false) {
    const open = this.rt.db
      .prepare("SELECT id FROM incidents WHERE provider = ? AND kind = ? AND closed_at IS NULL")
      .get(provider, kind) as { id: number } | undefined;
    if (open && !closeNow) return;
    const r = this.rt.db
      .prepare("INSERT INTO incidents (provider, kind, severity, summary, evidence, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(provider, kind, severity, summary, JSON.stringify(evidence), at, closeNow ? at : null);
    this.emit("incident", { id: Number(r.lastInsertRowid), provider, kind, severity, summary, openedAt: at });
  }

  private closeIncident(provider: string, kind: IncidentKind, at: string) {
    const r = this.rt.db.prepare("UPDATE incidents SET closed_at = ? WHERE provider = ? AND kind = ? AND closed_at IS NULL").run(at, provider, kind);
    if (Number(r.changes) > 0) this.emit("incident-closed", { provider, kind, closedAt: at });
  }

  private track(provider: string, kind: IncidentKind, bad: boolean, at: string, open: () => void) {
    const k = `${provider}:${kind}`;
    if (bad) {
      const n = (this.streak.get(k) ?? 0) + 1;
      this.streak.set(k, n);
      if (n >= CONSECUTIVE_TO_OPEN) open();
    } else {
      this.streak.set(k, 0);
      this.closeIncident(provider, kind, at);
    }
  }

  private evaluate(health: ProviderHealth[], at: string, withCaps: boolean): void {
    const expectedChain = this.rt.env.NEAR_NETWORK;
    for (const p of health) {
      this.track(p.provider, "PROVIDER_DOWN", !p.reachable, at, () =>
        this.openIncident(p.provider, "PROVIDER_DOWN", "major", `${p.provider} unreachable (${p.error?.kind}: ${p.error?.message?.slice(0, 120)})`, { error: p.error, latencyMs: p.latencyMs }, at),
      );
      if (p.reachable) {
        this.track(p.provider, "WRONG_CHAIN", p.chainId !== expectedChain, at, () =>
          this.openIncident(p.provider, "WRONG_CHAIN", "critical", `${p.provider} reports chain_id=${p.chainId}, expected ${expectedChain}`, { chainId: p.chainId }, at),
        );
        const lagging = (p.heightLag ?? 0) > this.rt.env.LAG_THRESHOLD_BLOCKS;
        this.track(p.provider, "PROVIDER_LAGGING", lagging, at, () =>
          this.openIncident(p.provider, "PROVIDER_LAGGING", "minor", `${p.provider} is ${p.heightLag} blocks behind the highest provider`, { heightLag: p.heightLag, height: p.latestBlockHeight }, at),
        );
      }
      if (withCaps && p.reachable) {
        const sig = JSON.stringify(p.capabilities);
        const prev = this.lastCaps.get(p.provider);
        if (prev !== undefined && prev !== sig) {
          this.openIncident(p.provider, "CAPABILITY_CHANGED", "info", `${p.provider} capabilities changed`, { before: JSON.parse(prev), after: p.capabilities }, at, true);
        }
        this.lastCaps.set(p.provider, sig);
      }
    }
  }
}
