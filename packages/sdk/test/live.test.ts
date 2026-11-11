/**
 * LIVE tests against public NEAR testnet RPCs. Run with `pnpm test:live`.
 * Read-only: nothing is signed or submitted. Results depend on third-party endpoints.
 *
 * Fixture txs were captured 2026-11-09. Non-archival nodes garbage-collect after ~5 epochs
 * (~2.5 days), so later runs are expected to find them only on archival providers. Assertions
 * therefore check the state and that >=1 provider found the tx, not unanimity.
 */
import { randomBytes } from "node:crypto";
import { baseEncode } from "near-api-js";
import { describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { fixture, makeSignedTx } from "./helpers.js";

const sentinel = new NearSentinel({ network: "testnet", timeoutMs: 15_000 });
const T = 90_000;

describe.each([
  ["tx-success.json", "EXECUTED_SUCCESS", "DO_NOT_RETRY"],
  // SAFE_TO_RETRY only while ≥ 2 independent operators still hold this (aging) tx at FINAL;
  // once only the archival operator has it, the honest answer is WAIT_AND_RECHECK. Checked below.
  ["tx-failure-panic.json", "EXECUTED_FAILURE", "SAFE_TO_RETRY_IF_2_OPERATORS"],
  ["tx-partial.json", "PARTIALLY_COMPLETED", "MANUAL_REVIEW_REQUIRED"],
] as const)("live inspect %s", (file, state, verdict) => {
  it(
    `→ ${state} / ${verdict}`,
    async () => {
      const f = fixture(file);
      const r = await sentinel.inspectTransaction({ transactionHash: f.transaction.hash, senderAccountId: f.transaction.signer_id });
      console.log(file, r.state, r.agreement, r.providers.map((p) => `${p.provider}:${p.outcome}${p.error ? `(${p.error.kind})` : ""}`).join(" "));
      expect(r.providers.some((p) => p.outcome === "FOUND")).toBe(true);
      expect(r.agreement).not.toBe("CONFLICTING");
      expect(r.state).toBe(state);
      if (verdict === "SAFE_TO_RETRY_IF_2_OPERATORS") {
        const ops = new Set(r.providers.filter((p) => p.outcome === "FOUND" && p.finalExecutionStatus === "FINAL").map((p) => p.operator)).size;
        expect(r.retryRecommendation.verdict).toBe(ops >= 2 ? "SAFE_TO_RETRY" : "WAIT_AND_RECHECK");
      } else {
        expect(r.retryRecommendation.verdict).toBe(verdict);
      }
      expect(r.finalized).toBe(true);
    },
    T,
  );
});

describe("live unknown transaction", () => {
  it(
    "random hash → UNKNOWN + WAIT_AND_RECHECK (absence is not proof)",
    async () => {
      const r = await sentinel.inspectTransaction({ transactionHash: baseEncode(randomBytes(32)), senderAccountId: "testnet" });
      expect(r.state).toBe("UNKNOWN");
      expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
      expect(r.providers.some((p) => p.outcome === "NOT_FOUND")).toBe(true);
    },
    T,
  );

  it(
    "never-broadcast signed tx with a non-existent key → coverage phase runs, verdict is NOT SAFE",
    async () => {
      const head = (await sentinel.read<any>("block", { finality: "final" })).at(-1)!;
      expect(head.ok).toBe(true);
      const st = makeSignedTx({ signerId: "testnet", nonce: 1n, blockHash: head.result.header.hash });
      const r = await sentinel.inspectTransaction({ signedTransactionBase64: st.base64 });
      console.log("signed-unknown", r.retryRecommendation.verdict, r.retryRecommendation.checks.map((c) => `${c.id}=${c.passed}`).join(" "));
      expect(r.observations.some((o) => o.method === "query")).toBe(true);
      expect(r.observations.some((o) => o.method === "block")).toBe(true);
      // The random key does not exist on `testnet`: every answering provider must report it missing,
      // which escalates to manual review (a missing key is never proof the tx cannot land).
      expect(r.retryRecommendation.checks.filter((c) => c.id.startsWith("proof:")).some((c) => c.detail.includes("keyMissing=true"))).toBe(true);
      expect(r.retryRecommendation.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    },
    T,
  );
});

describe("live SSRF-guarded transport", () => {
  it(
    "createGuardedFetch() reaches real public RPCs, and the byte cap still applies",
    async () => {
      const { createGuardedFetch } = await import("../src/ssrf.js");
      const { rpcCall } = await import("../src/rpc.js");
      const guarded = new NearSentinel({ network: "testnet", timeoutMs: 15_000, fetch: createGuardedFetch() });
      const f = fixture("tx-failure-panic.json");
      const r = await guarded.inspectTransaction({ transactionHash: f.transaction.hash, senderAccountId: f.transaction.signer_id });
      expect(r.state).toBe("EXECUTED_FAILURE");
      const capped = await rpcCall(
        // Archival: still holds this tx (a regular node may have forgotten it and answer with a tiny error).
        { name: "fastnear-archival", url: "https://archival-rpc.testnet.fastnear.com" },
        "EXPERIMENTAL_tx_status",
        { tx_hash: f.transaction.hash, sender_account_id: f.transaction.signer_id, wait_until: "NONE" },
        { timeoutMs: 15_000, maxResponseBytes: 2_000, fetch: createGuardedFetch() },
      );
      expect(capped.error?.kind).toBe("TOO_LARGE");
    },
    T,
  );
});

describe("live provider health", () => {
  it(
    "all default providers are probed; capabilities are tested, not self-reported",
    async () => {
      const h = await sentinel.getProviderHealth();
      for (const p of h) {
        console.log(
          p.provider,
          p.reachable ? "up" : `DOWN(${p.error?.kind})`,
          `${p.latencyMs}ms`,
          `lag=${p.heightLag}`,
          JSON.stringify(p.capabilities),
        );
      }
      expect(h.filter((p) => p.reachable).length).toBeGreaterThanOrEqual(2);
      expect(h.every((p) => !p.reachable || p.chainId === "testnet")).toBe(true);
      const archival = h.find((p) => p.provider === "fastnear-archival");
      if (archival?.reachable) expect(archival.capabilities.archival).toBe(true);
      const fast = h.find((p) => p.provider === "fastnear");
      if (fast?.reachable) {
        expect(fast.capabilities.archival).toBe(false);
        expect(fast.capabilities.supportsTxStatusMethod).toBe(true);
      }
      // Documented observation (2026-11-09): dRPC testnet rejects `tx_status`. If this starts failing,
      // dRPC changed — update docs/research, not the engine.
      const drpc = h.find((p) => p.provider === "drpc");
      if (drpc?.reachable) expect(drpc.capabilities.supportsTxStatusMethod).toBe(false);
    },
    T,
  );
});
