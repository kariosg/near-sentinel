import { assertPublicRpcUrl, createGuardedFetch, NearSentinel, type ProviderConfig } from "@near-sentinel/sdk";

/**
 * Configuration from environment variables:
 *   NEAR_SENTINEL_NETWORK        testnet (default) | mainnet
 *   NEAR_SENTINEL_RPC_URLS       optional "name=url[|operator],name=url[|operator]" — replaces the defaults
 *   NEAR_SENTINEL_MIN_OPERATORS  independent operators required for SAFE_TO_RETRY (default 2)
 *   NEAR_SENTINEL_TIMEOUT_MS     per-request deadline (default 10000)
 *   NEAR_SENTINEL_ALLOW_PRIVATE  "1" allows localhost/private RPC URLs (local fault-injection demos only)
 */
export async function sentinelFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<NearSentinel> {
  const network = (env.NEAR_SENTINEL_NETWORK ?? "testnet") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error(`NEAR_SENTINEL_NETWORK must be testnet or mainnet, got ${network}`);
  const allowPrivate = env.NEAR_SENTINEL_ALLOW_PRIVATE === "1";
  let rpcProviders: ProviderConfig[] | undefined;
  if (env.NEAR_SENTINEL_RPC_URLS) {
    rpcProviders = [];
    for (const part of env.NEAR_SENTINEL_RPC_URLS.split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq < 1) throw new Error(`Bad NEAR_SENTINEL_RPC_URLS entry "${part}" (expected name=url)`);
      const name = part.slice(0, eq);
      const [url, operator] = part.slice(eq + 1).split("|");
      await assertPublicRpcUrl(url!, { allowPrivateNetworks: allowPrivate, allowHttp: allowPrivate });
      rpcProviders.push({ name, url: url!, operator: operator || undefined });
    }
  }
  return new NearSentinel({
    network,
    rpcProviders,
    minIndependentOperators: env.NEAR_SENTINEL_MIN_OPERATORS ? Number(env.NEAR_SENTINEL_MIN_OPERATORS) : undefined,
    timeoutMs: env.NEAR_SENTINEL_TIMEOUT_MS ? Number(env.NEAR_SENTINEL_TIMEOUT_MS) : 10_000,
    fetch: rpcProviders ? createGuardedFetch({ allowPrivateNetworks: allowPrivate }) : undefined,
  });
}
