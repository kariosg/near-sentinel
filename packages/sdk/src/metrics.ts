import type { RpcFailureKind, RpcObservation } from "./types.js";

export interface ProviderMetrics {
  provider: string;
  operator: string;
  requests: number;
  ok: number;
  /** Answered with a well-formed JSON-RPC error (e.g. UNKNOWN_TRANSACTION). This is still an answer. */
  rpcErrors: number;
  failures: Partial<Record<RpcFailureKind, number>>;
  /** ok + rpcErrors over requests. */
  answerRate: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; samples: number };
  lastObservedAt?: string;
  /** Below this many requests, rates are reported but flagged as insufficient. */
  sufficientSample: boolean;
}

export const MIN_SAMPLE = 30;

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

/** In-memory rolling metrics. Bounded: last `window` latency samples per provider. */
export class MetricsCollector {
  private readonly data = new Map<
    string,
    { operator: string; requests: number; ok: number; rpcErrors: number; failures: Partial<Record<RpcFailureKind, number>>; lat: number[]; last?: string }
  >();
  constructor(private readonly window = 1000) {}

  record(o: RpcObservation): void {
    let d = this.data.get(o.provider);
    if (!d) {
      d = { operator: o.operator, requests: 0, ok: 0, rpcErrors: 0, failures: {}, lat: [] };
      this.data.set(o.provider, d);
    }
    d.requests++;
    d.last = o.observedAt;
    if (o.ok) d.ok++;
    else if (o.error?.kind === "RPC_ERROR") d.rpcErrors++;
    else if (o.error) d.failures[o.error.kind] = (d.failures[o.error.kind] ?? 0) + 1;
    // Only time requests that got a response; timeouts would just record the deadline.
    if (o.ok || o.error?.kind === "RPC_ERROR") {
      d.lat.push(o.latencyMs);
      if (d.lat.length > this.window) d.lat.shift();
    }
  }

  snapshot(): ProviderMetrics[] {
    return [...this.data.entries()].map(([provider, d]) => {
      const sorted = [...d.lat].sort((a, b) => a - b);
      return {
        provider,
        operator: d.operator,
        requests: d.requests,
        ok: d.ok,
        rpcErrors: d.rpcErrors,
        failures: { ...d.failures },
        answerRate: d.requests ? (d.ok + d.rpcErrors) / d.requests : null,
        latencyMs: { p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), samples: sorted.length },
        lastObservedAt: d.last,
        sufficientSample: d.requests >= MIN_SAMPLE,
      };
    });
  }

  reset(): void {
    this.data.clear();
  }
}
