import {
  createGuardedFetch,
  DEFAULT_PROVIDERS,
  MetricsCollector,
  NearSentinel,
  type FetchLike,
  type InspectionResult,
  type ProviderConfig,
  type ProviderHealth,
} from "@near-sentinel/sdk";
import type { Db } from "./db.js";
import type { Env } from "./env.js";

export function parseRpcUrls(s: string): ProviderConfig[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 1) throw new Error(`Bad RPC_URLS entry "${part}" (expected name=url|operator)`);
      const [url, operator] = part.slice(eq + 1).split("|");
      return { name: part.slice(0, eq), url: url!, operator: operator || undefined };
    });
}

export interface HealthSnapshot {
  checkedAt: string;
  providers: Array<Omit<ProviderHealth, "observations">>;
}

/**
 * Owns the current NearSentinel. Rebuilt when custom providers change; metrics survive rebuilds.
 * Also de-duplicates concurrent identical inspections (single-flight) so that a burst of identical
 * retry-checks (e.g. an agent retrying the check itself) costs one upstream fan-out.
 */
export class Runtime {
  readonly metrics = new MetricsCollector();
  sentinel!: NearSentinel;
  lastHealth?: HealthSnapshot;
  private inflight = new Map<string, Promise<InspectionResult>>();
  readonly fetchImpl: FetchLike;

  constructor(
    readonly env: Env,
    readonly db: Db,
  ) {
    this.fetchImpl = createGuardedFetch({ allowPrivateNetworks: env.ALLOW_PRIVATE_RPC });
    this.rebuild();
  }

  baseProviders(): ProviderConfig[] {
    return this.env.RPC_URLS ? parseRpcUrls(this.env.RPC_URLS) : DEFAULT_PROVIDERS[this.env.NEAR_NETWORK];
  }

  customProviders(): ProviderConfig[] {
    return (this.db.prepare("SELECT name, url, operator FROM custom_providers ORDER BY added_at").all() as any[]).map((r) => ({
      name: String(r.name),
      url: String(r.url),
      operator: String(r.operator),
    }));
  }

  rebuild(): void {
    this.sentinel = new NearSentinel({
      network: this.env.NEAR_NETWORK,
      rpcProviders: [...this.baseProviders(), ...this.customProviders()],
      timeoutMs: this.env.RPC_TIMEOUT_MS,
      minIndependentOperators: this.env.MIN_INDEPENDENT_OPERATORS,
      fetch: this.fetchImpl,
      metrics: this.metrics,
    });
  }

  inspect(input: Parameters<NearSentinel["inspectTransaction"]>[0]): Promise<InspectionResult> {
    const key = JSON.stringify(input);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.sentinel.inspectTransaction(input).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }
}
