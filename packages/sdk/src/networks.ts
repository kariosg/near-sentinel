import type { ProviderConfig } from "./types.js";

/**
 * Default free, key-less providers. Verified reachable on 2026-11-09.
 * Operators are labelled so FastNEAR's two hostnames are not counted as two witnesses.
 * rpc.*.near.org is deprecated and rate-limited (30 req/min); it is kept as an
 * independent witness but given a low weight.
 */
export const DEFAULT_PROVIDERS: Record<"mainnet" | "testnet", ProviderConfig[]> = {
  testnet: [
    { name: "fastnear", url: "https://test.rpc.fastnear.com", operator: "fastnear", weight: 3 },
    { name: "fastnear-archival", url: "https://archival-rpc.testnet.fastnear.com", operator: "fastnear", archival: true, weight: 1 },
    { name: "drpc", url: "https://near-testnet.drpc.org", operator: "drpc", weight: 2 },
    { name: "near-org", url: "https://rpc.testnet.near.org", operator: "near.org", weight: 1 },
  ],
  mainnet: [
    { name: "fastnear", url: "https://free.rpc.fastnear.com", operator: "fastnear", weight: 3 },
    { name: "fastnear-archival", url: "https://archival-rpc.mainnet.fastnear.com", operator: "fastnear", archival: true, weight: 1 },
    { name: "drpc", url: "https://near.drpc.org", operator: "drpc", weight: 2 },
    { name: "near-org", url: "https://rpc.mainnet.near.org", operator: "near.org", weight: 1 },
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
