import type { ProviderConfig } from "./types.js";

/**
 * Default free, key-less providers. Verified reachable on 2026-11-11.
 * Operators are labelled so one company's hostnames are never counted as two witnesses.
 * Independence was checked by DNS on 2026-11-11: rpc.{testnet,mainnet}.near.org are CNAMEs to
 * external-dns.fastnear.com (FastNEAR infrastructure), so they are NOT an independent operator and are
 * not in the defaults. Intear runs its own nodes on separate infrastructure; without an API key it adds ~1 s
 * per request but has no tight rate limit (Tatum's free gateway was rejected: 5 requests/minute per IP).
 */
export const DEFAULT_PROVIDERS: Record<"mainnet" | "testnet", ProviderConfig[]> = {
  testnet: [
    { name: "fastnear", url: "https://test.rpc.fastnear.com", operator: "fastnear", weight: 3 },
    { name: "fastnear-archival", url: "https://archival-rpc.testnet.fastnear.com", operator: "fastnear", archival: true, weight: 1 },
    { name: "drpc", url: "https://near-testnet.drpc.org", operator: "drpc", weight: 2 },
    { name: "intear", url: "https://testnet-rpc.intea.rs", operator: "intear", weight: 1 },
  ],
  mainnet: [
    { name: "fastnear", url: "https://free.rpc.fastnear.com", operator: "fastnear", weight: 3 },
    { name: "fastnear-archival", url: "https://archival-rpc.mainnet.fastnear.com", operator: "fastnear", archival: true, weight: 1 },
    { name: "drpc", url: "https://near.drpc.org", operator: "drpc", weight: 2 },
    { name: "intear", url: "https://rpc.intea.rs", operator: "intear", weight: 1 },
  ],
};

/** A block height that every non-archival node has garbage-collected; used to probe archival capability. */
export const ARCHIVAL_PROBE_HEIGHT: Record<"mainnet" | "testnet", number> = {
  testnet: 100_000_000,
  mainnet: 100_000_000,
};

/** Protocol default; refreshed from EXPERIMENTAL_protocol_config at runtime when possible. */
export const DEFAULT_TX_VALIDITY_PERIOD = 86_400;

/** 32 zero bytes in base58 — guaranteed not to be a real tx/receipt hash. Used for capability probes. */
export const NULL_HASH = "11111111111111111111111111111111";
