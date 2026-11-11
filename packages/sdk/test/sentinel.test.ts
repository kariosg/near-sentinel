import { afterEach, describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { SentinelInputError } from "../src/errors.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";
import type { ProviderConfig } from "../src/types.js";
import { fixture, makeSignedTx } from "./helpers.js";

/* ----------------------------- mock chain kit ----------------------------- */

const UNKNOWN_TX: MockAnswer = {
  error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } },
};
const UNKNOWN_BLOCK: MockAnswer = {
  error: { name: "HANDLER_ERROR", code: -32000, message: "DB Not Found", cause: { name: "UNKNOWN_BLOCK", info: {} } },
};
const HEAD = 5_000_000;

interface ChainOpts {
  tx?: (call: number) => MockAnswer; // answer for EXPERIMENTAL_tx_status, by call index
  akNonce?: bigint; // access key nonce at final
  akMissing?: boolean;
  knowsBlock?: string; // block hash this node has (window coverage)
  blockHeight?: number;
  methods?: Partial<Record<string, MockAnswer>>;
}

/** Shared, totally-ordered log across all mock providers (for ordering assertions). */
let seq = 0;
const log: Array<{ seq: number; provider: string; method: string; params: any }> = [];
const servers: RunningServer[] = [];

async function chain(name: string, o: ChainOpts): Promise<ProviderConfig> {
  let txCalls = 0;
  const srv = await startMockRpc((method, params) => {
    log.push({ seq: seq++, provider: name, method, params });
    if (o.methods?.[method]) return o.methods[method]!;
    switch (method) {
      case "EXPERIMENTAL_tx_status":
        return o.tx ? o.tx(txCalls++) : UNKNOWN_TX;
      case "query":
        if (o.akMissing)
          // Real shape captured live 2026-11-09: a successful result with an `error` string.
          return {
            result: {
              block_hash: "8mS3hEfZhcQJEzvUrnrxBNgfQen2pK5avVybbd3DB17m",
              block_height: HEAD,
              error: `access key ${params.public_key} does not exist while viewing`,
              logs: [],
            },
          };
        return { result: { nonce: Number(o.akNonce ?? 0n), block_height: HEAD, block_hash: "x", permission: "FullAccess" } };
      case "block":
        if (params.finality) return { result: { header: { height: HEAD, timestamp_nanosec: String(HEAD * 600_000_000) } } };
        if (typeof params.block_id === "number") return { result: { header: { height: params.block_id, timestamp_nanosec: String(params.block_id * 600_000_000) } } };
        return params.block_id === o.knowsBlock ? { result: { header: { hash: params.block_id, height: o.blockHeight ?? HEAD - 100, timestamp_nanosec: "0" } } } : UNKNOWN_BLOCK;
      case "EXPERIMENTAL_protocol_config":
        return { result: { transaction_validity_period: 86_400 } };
      case "status":
        return { result: { chain_id: "testnet", protocol_version: 88, sync_info: { latest_block_height: HEAD, earliest_block_height: 1, syncing: false } } };
      default:
        return UNKNOWN_TX;
    }
  });
  servers.push(srv);
  return { name, url: srv.url, operator: name.split("-")[0] };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  log.length = 0;
});

const success = fixture("tx-success.json");
const found = (r = success): MockAnswer => ({ result: r });
const S = (providers: ProviderConfig[], extra = {}) => new NearSentinel({ rpcProviders: providers, timeoutMs: 1500, ...extra });

/* --------------------------------- tests --------------------------------- */

describe("inspectTransaction across providers", () => {
  const input = { transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id };

  it("found by all → UNANIMOUS, EXECUTED_SUCCESS, DO_NOT_RETRY, receipt tree", async () => {
    const s = S([await chain("a", { tx: () => found() }), await chain("b", { tx: () => found() }), await chain("c", { tx: () => found() })]);
    const r = await s.inspectTransaction(input);
    expect(r.state).toBe("EXECUTED_SUCCESS");
    expect(r.agreement).toBe("UNANIMOUS");
    expect(r.finalized).toBe(true);
    expect(r.retryRecommendation.verdict).toBe("DO_NOT_RETRY");
    expect(r.receiptTree?.actions[0]?.methodName).toBe("request_credit");
    expect(r.providers.map((p) => p.outcome)).toEqual(["FOUND", "FOUND", "FOUND"]);
    expect(r.observations).toHaveLength(3);
  });

  it("one lagging provider → CONSISTENT_WITH_LAG, positive evidence wins", async () => {
    const s = S([await chain("a", { tx: () => found() }), await chain("b", { tx: () => UNKNOWN_TX })]);
    const r = await s.inspectTransaction(input);
    expect(r.state).toBe("EXECUTED_SUCCESS");
    expect(r.agreement).toBe("CONSISTENT_WITH_LAG");
    const d = r.diagnostics.find((x) => x.code === "PROVIDER_DISAGREEMENT");
    expect(d?.confidence).toBe("medium");
    expect(d?.explanation).toMatch(/not with misbehaviour/);
    expect(r.retryRecommendation.verdict).toBe("DO_NOT_RETRY");
  });

  it("a stale provider (fault) cannot flip a found tx to unknown", async () => {
    const s = S([await chain("a", { tx: () => found() }), await chain("b", { tx: () => ({ fault: { type: "stale-unknown-tx" } }) })]);
    const r = await s.inspectTransaction(input);
    expect(r.state).toBe("EXECUTED_SUCCESS");
    expect(r.retryRecommendation.verdict).toBe("DO_NOT_RETRY");
  });

  it("conflicting executed outcomes → CONFLICTING + MANUAL_REVIEW_REQUIRED", async () => {
    const tampered = structuredClone(success); // synthetic: same hash, different outcome
    tampered.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "x" } } } } };
    tampered.receipts_outcome[0]!.outcome.status = tampered.status;
    const s = S([await chain("a", { tx: () => found() }), await chain("b", { tx: () => found(tampered) })]);
    const r = await s.inspectTransaction(input);
    expect(r.agreement).toBe("CONFLICTING");
    expect(r.retryRecommendation.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    expect(r.diagnostics.some((d) => d.code === "PROVIDER_DISAGREEMENT" && d.confidence === "high")).toBe(true);
  });

  it("a provider returning a DIFFERENT tx is rejected as MALFORMED, not trusted", async () => {
    const other = fixture("tx-failure-panic.json");
    const s = S([await chain("a", { tx: () => found(other) }), await chain("b", { tx: () => UNKNOWN_TX })]);
    const r = await s.inspectTransaction(input);
    expect(r.state).toBe("UNKNOWN");
    expect(r.providers[0]!.outcome).toBe("ERROR");
    expect(r.diagnostics.some((d) => d.code === "MALFORMED_RESPONSE")).toBe(true);
  });

  describe("a found FAILURE only proves safety when FINAL on enough independent operators", () => {
    const panic = fixture("tx-failure-panic.json");
    const pin = { transactionHash: panic.transaction.hash, senderAccountId: panic.transaction.signer_id };
    const asStatus = (st: string) => ({ ...structuredClone(panic), final_execution_status: st });

    it("one operator reports the failure, the others have not seen it → WAIT, never SAFE", async () => {
      const s = S([await chain("a", { tx: () => found(panic) }), await chain("b", { tx: () => UNKNOWN_TX })]);
      const r = await s.inspectTransaction(pin);
      expect(r.state).toBe("EXECUTED_FAILURE");
      expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
    });

    it("failure seen only at EXECUTED_OPTIMISTIC on two operators → WAIT, never SAFE", async () => {
      const s = S([await chain("a", { tx: () => found(asStatus("EXECUTED_OPTIMISTIC") as any) }), await chain("b", { tx: () => found(asStatus("EXECUTED_OPTIMISTIC") as any) })]);
      const r = await s.inspectTransaction(pin);
      expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
    });

    it("same failure at FINAL on two independent operators → SAFE_TO_RETRY", async () => {
      const s = S([await chain("a", { tx: () => found(panic) }), await chain("b", { tx: () => found(panic) })]);
      const r = await s.inspectTransaction(pin);
      expect(r.retryRecommendation.verdict).toBe("SAFE_TO_RETRY");
    });

    it("two providers of the SAME operator do not count twice", async () => {
      const s = S([await chain("fast-a", { tx: () => found(panic) }), await chain("fast-b", { tx: () => found(panic) })]);
      const r = await s.inspectTransaction(pin);
      expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
    });
  });

  it("all providers down → INSUFFICIENT, INCOMPLETE_EVIDENCE, WAIT low", async () => {
    const s = S([
      await chain("a", { tx: () => ({ fault: { type: "http-502" } }) }),
      await chain("b", { tx: () => ({ fault: { type: "reset" } }) }),
    ]);
    const r = await s.inspectTransaction(input);
    expect(r.agreement).toBe("INSUFFICIENT");
    expect(r.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["INCOMPLETE_EVIDENCE", "NETWORK_UNAVAILABLE"]));
    expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
    expect(r.retryRecommendation.confidence).toBe("low");
  });
});

describe("retry safety with a signed transaction", () => {
  it("nonce consumed by another tx, 2 operators cover the window, not found → SAFE + EXPIRED_OR_UNRESOLVED, correct ordering", async () => {
    const st = makeSignedTx({ nonce: 100n });
    const s = S([
      await chain("fast-a", { akNonce: 105n, knowsBlock: st.blockHash }),
      await chain("drpc-b", { akNonce: 105n, knowsBlock: st.blockHash }),
    ]);
    const r = await s.inspectTransaction({ signedTransactionBase64: st.base64 });
    expect(r.txHash).toBe(st.hash);
    expect(r.retryRecommendation.verdict).toBe("SAFE_TO_RETRY");
    expect(r.state).toBe("EXPIRED_OR_UNRESOLVED");

    // Ordering guarantee: per provider, the access-key read happens BEFORE the final tx lookup.
    for (const p of ["fast-a", "drpc-b"]) {
      const mine = log.filter((l) => l.provider === p);
      const ak = mine.find((l) => l.method === "query")!.seq;
      const txs = mine.filter((l) => l.method === "EXPERIMENTAL_tx_status").map((l) => l.seq);
      expect(txs).toHaveLength(2);
      expect(ak).toBeLessThan(txs[1]!);
      expect(ak).toBeGreaterThan(txs[0]!);
    }
    // Every tx-status query is non-blocking.
    expect(log.filter((l) => l.method === "EXPERIMENTAL_tx_status").every((l) => l.params.wait_until === "NONE")).toBe(true);
  });

  it("a provider answering the block lookup with a DIFFERENT block cannot fake expiry", async () => {
    const st = makeSignedTx({ nonce: 100n });
    const wrongBlock: MockAnswer = { result: { header: { hash: "11111111111111111111111111111111", height: 1, timestamp_nanosec: "0" } } };
    const lying = await chain("a", { akNonce: 99n, knowsBlock: st.blockHash });
    const honest = await chain("b", { akNonce: 99n, knowsBlock: st.blockHash });
    // Provider "c" claims the tx block is at height 1 (so it would look expired everywhere).
    const c = await chain("c", { akNonce: 99n, methods: { block: wrongBlock } });
    const s = S([c, lying, honest]);
    const r = await s.inspectTransaction({ signedTransactionBase64: st.base64 });
    expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
  });

  it("nonce not consumed and block recent → WAIT_AND_RECHECK, state UNKNOWN, ETA uses measured block time", async () => {
    const st = makeSignedTx({ nonce: 100n });
    const s = S([await chain("a", { akNonce: 99n, knowsBlock: st.blockHash }), await chain("b", { akNonce: 99n, knowsBlock: st.blockHash })]);
    const r = await s.inspectTransaction({ signedTransactionBase64: st.base64 });
    expect(r.state).toBe("UNKNOWN");
    expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
    expect(r.retryRecommendation.reason).toMatch(/86300 more blocks/);
    expect(r.retryRecommendation.reason).toMatch(/0\.60 s\/block/);
  });

  it("tx lands between the two lookups → found in second lookup → DO_NOT_RETRY", async () => {
    const st = makeSignedTx({ nonce: 100n });
    const landed = structuredClone(success);
    landed.transaction.hash = st.hash; // synthetic: the tx we are checking lands mid-inspection
    const s = S([
      await chain("a", { akNonce: 100n, knowsBlock: st.blockHash, tx: (i) => (i === 0 ? UNKNOWN_TX : found(landed)) }),
      await chain("b", { akNonce: 100n, knowsBlock: st.blockHash }),
    ]);
    const r = await s.inspectTransaction({ signedTransactionBase64: st.base64 });
    expect(r.retryRecommendation.verdict).toBe("DO_NOT_RETRY");
  });

  it("missing access key (real legacy `result.error` shape) → MANUAL_REVIEW_REQUIRED, never SAFE", async () => {
    const st = makeSignedTx({ nonce: 100n });
    const s = S([
      await chain("a", { akMissing: true, knowsBlock: st.blockHash }),
      await chain("b", { akMissing: true, knowsBlock: st.blockHash }),
    ]);
    const r = await s.inspectTransaction({ signedTransactionBase64: st.base64 });
    expect(r.retryRecommendation.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    expect(r.retryRecommendation.checks.find((c) => c.id === "proof:a")?.detail).toContain("keyMissing=true");
  });

  it("providers that do not hold the window cannot prove anything → not SAFE, HISTORY_NOT_COVERED", async () => {
    const st = makeSignedTx({ nonce: 100n });
    const s = S([await chain("a", { akNonce: 105n }), await chain("b", { akNonce: 105n })]);
    const r = await s.inspectTransaction({ signedTransactionBase64: st.base64 });
    expect(r.retryRecommendation.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    expect(r.diagnostics.some((d) => d.code === "HISTORY_NOT_COVERED")).toBe(true);
  });

  it("hash-only inspection never runs the coverage phase and never reports HISTORY_NOT_COVERED", async () => {
    const s = S([await chain("a", {}), await chain("b", {})]);
    const r = await s.inspectTransaction({ transactionHash: success.transaction.hash, senderAccountId: "alice.testnet" });
    expect(r.diagnostics.some((d) => d.code === "HISTORY_NOT_COVERED")).toBe(false);
    expect(log.some((l) => l.method === "query")).toBe(false);
    expect(r.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
  });
});

describe("input validation", () => {
  it("rejects malformed hashes and account ids", async () => {
    const s = S([await chain("a", {})]);
    await expect(s.inspectTransaction({ transactionHash: "zzz", senderAccountId: "alice.testnet" })).rejects.toBeInstanceOf(SentinelInputError);
    await expect(s.inspectTransaction({ transactionHash: success.transaction.hash, senderAccountId: "Alice!" })).rejects.toBeInstanceOf(SentinelInputError);
    await expect(s.inspectTransaction({} as any)).rejects.toBeInstanceOf(SentinelInputError);
    expect(log).toHaveLength(0); // nothing was sent to the network
  });

  it("rejects a transactionHash that does not match the signed tx", async () => {
    const st = makeSignedTx();
    const s = S([await chain("a", {})]);
    await expect(s.inspectTransaction({ signedTransactionBase64: st.base64, transactionHash: success.transaction.hash })).rejects.toThrow(/does not match/);
  });

  it("rejects duplicate provider names and non-http URLs", () => {
    expect(() => new NearSentinel({ rpcProviders: [{ name: "a", url: "https://x.org" }, { name: "a", url: "https://y.org" }] })).toThrow(SentinelInputError);
    expect(() => new NearSentinel({ rpcProviders: [{ name: "a", url: "file:///etc/passwd" }] })).toThrow(SentinelInputError);
  });
});

describe("provider tooling", () => {
  it("getProviderHealth reports tested capabilities, incl. tx_status unsupported (dRPC shape)", async () => {
    const noTxStatus: MockAnswer = { error: { message: "method is not available", code: -32601 }, httpStatus: 400 };
    const s = S([await chain("a", {}), await chain("b", { methods: { tx_status: noTxStatus } })]);
    const h = await s.getProviderHealth();
    expect(h[0]!.reachable).toBe(true);
    expect(h[0]!.capabilities.supportsTxStatusMethod).toBe(true);
    expect(h[1]!.capabilities.supportsTxStatusMethod).toBe(false);
    expect(h[1]!.capabilities.supportsExperimentalTxStatus).toBe(true);
    expect(h[0]!.heightLag).toBe(0);
  });

  it("compareProviders refuses anything that is not an allow-listed READ method", async () => {
    const s = S([await chain("a", {})]);
    await expect(s.compareProviders({ method: "send_tx", params: {} })).rejects.toThrow(/not an allow-listed/);
    await expect(s.compareProviders({ method: "broadcast_tx_commit", params: [] })).rejects.toThrow(/not an allow-listed/);
    expect(log).toHaveLength(0);
  });

  it("compareProviders groups identical answers", async () => {
    const s = S([await chain("a", {}), await chain("b", {}), await chain("c", { methods: { status: { result: { chain_id: "mainnet" } } } })]);
    const c = await s.compareProviders({ method: "status", params: [] });
    expect(c.agreement).toBe("SPLIT");
    expect(c.groups.map((g) => g.providers.length).sort()).toEqual([1, 2]);
  });

  it("read() fails over on transport failure but not on deterministic answers", async () => {
    const s = S([
      { ...(await chain("a", { methods: { status: { fault: { type: "http-502" } } } })), weight: 5 },
      { ...(await chain("b", {})), weight: 1 },
    ]);
    const trail = await s.read("status", []);
    expect(trail.map((t) => [t.provider, t.ok])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("metrics are recorded per provider", async () => {
    const s = S([await chain("a", { tx: () => found() })]);
    await s.inspectTransaction({ transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id });
    const m = s.getProviderMetrics();
    expect(m[0]!.requests).toBe(1);
    expect(m[0]!.sufficientSample).toBe(false);
  });

  it("subscribeToTransaction yields INCLUDED then final success, then stops", async () => {
    const included = structuredClone(success);
    included.final_execution_status = "INCLUDED"; // synthetic
    const s = S([await chain("a", { tx: (i) => found(i === 0 ? included : success) })]);
    const states: string[] = [];
    for await (const u of s.subscribeToTransaction(
      { transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id },
      { intervalMs: 1000, timeoutMs: 10_000 },
    )) {
      states.push(`${u.state}/${u.finalExecutionStatus}`);
    }
    expect(states).toEqual(["INCLUDED/INCLUDED", "EXECUTED_SUCCESS/FINAL"]);
  });

  it("exportDiagnosticReport has a stable schema and is JSON-safe", async () => {
    const s = S([await chain("a", { tx: () => found() })]);
    const i = await s.inspectTransaction({ transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id });
    const rep = s.exportDiagnosticReport(i);
    expect(rep.schema).toBe("near-sentinel/diagnostic-report@1");
    expect(JSON.parse(JSON.stringify(rep)).inspection.state).toBe("EXECUTED_SUCCESS");
  });
});
