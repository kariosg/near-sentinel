/**
 * LIVE, READ-ONLY tests against public NEAR **mainnet** RPCs. Run with `pnpm test:live`.
 * Nothing is signed or sent and no key is used. The transaction under test is picked dynamically
 * from a recent final block, so no hardcoded hash can age out of non-archival history.
 */
import { describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";

const RPC = "https://free.rpc.fastnear.com";
const T = 90_000;
const sentinel = new NearSentinel({ network: "mainnet", timeoutMs: 15_000 });

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

/** A recent, successfully executed mainnet transaction (hash + signer), found by walking final blocks. */
async function recentSuccessfulTx(): Promise<{ hash: string; signer: string }> {
  let block = await rpc("block", { finality: "final" });
  for (let b = 0; b < 15; b++) {
    for (const ch of block.chunks ?? []) {
      if (!ch.tx_root || /^1+$/.test(ch.tx_root)) continue;
      const chunk = await rpc("chunk", { chunk_id: ch.chunk_hash }).catch(() => undefined);
      for (const tx of chunk?.transactions ?? []) {
        const st = await rpc("EXPERIMENTAL_tx_status", { tx_hash: tx.hash, sender_account_id: tx.signer_id, wait_until: "NONE" }).catch(() => undefined);
        const s = st?.status ?? {};
        const failed = JSON.stringify(st?.receipts_outcome ?? []).includes('"Failure"');
        if (st?.final_execution_status === "FINAL" && ("SuccessValue" in s || "SuccessReceiptId" in s) && !failed) return { hash: tx.hash, signer: tx.signer_id };
      }
    }
    block = await rpc("block", { block_id: block.header.prev_hash });
  }
  throw new Error("no successful transaction found in the last 15 final blocks");
}

describe("live mainnet (read-only)", () => {
  it(
    "default mainnet providers answer with chain_id mainnet from at least 2 independent operators",
    async () => {
      const h = await sentinel.getProviderHealth();
      const up = h.filter((p) => p.reachable && p.chainId === "mainnet");
      console.log(h.map((p) => `${p.provider}:${p.reachable ? p.chainId : "down"}`).join(" "));
      expect(h.every((p) => !p.reachable || p.chainId === "mainnet")).toBe(true);
      expect(new Set(up.map((p) => p.operator)).size).toBeGreaterThanOrEqual(2);
    },
    T,
  );

  it(
    "a real, recent, successful mainnet transaction is DO_NOT_RETRY (never SAFE_TO_RETRY)",
    async () => {
      const { hash, signer } = await recentSuccessfulTx();
      const r = await sentinel.checkRetrySafety({ transactionHash: hash, senderAccountId: signer });
      console.log("mainnet tx", hash, signer, r.state, r.verdict);
      expect(r.state).toBe("EXECUTED_SUCCESS");
      expect(r.verdict).toBe("DO_NOT_RETRY");
    },
    T,
  );

  it(
    "an unknown transaction hash on mainnet is WAIT_AND_RECHECK, never SAFE",
    async () => {
      const r = await sentinel.checkRetrySafety({ transactionHash: "11111111111111111111111111111112", senderAccountId: "near" });
      expect(r.verdict).not.toBe("SAFE_TO_RETRY");
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
    },
    T,
  );
});
