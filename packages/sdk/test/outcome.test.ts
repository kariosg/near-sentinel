import { describe, expect, it } from "vitest";
import { buildReceiptTree, classifyFound, flattenFailure, outcomeDigest, totals } from "../src/outcome.js";
import { diagnoseOutcome } from "../src/diagnostics.js";
import { decodeSignedTx } from "../src/signedtx.js";
import { fixture, makeSignedTx } from "./helpers.js";

describe("receipt tree + state classification (real testnet fixtures)", () => {
  it("simple success → EXECUTED_SUCCESS, refund flagged", () => {
    const r = fixture("tx-success-2receipts.json");
    const { root, nodes } = buildReceiptTree(r);
    expect(root?.executorId).toBe("league-v8.near-post.testnet");
    expect(root?.actions[0]?.methodName).toBe("report_for_match");
    expect(nodes).toHaveLength(2);
    expect(nodes.filter((n) => n.isRefund)).toHaveLength(1);
    const c = classifyFound(r, nodes);
    expect(c.state).toBe("EXECUTED_SUCCESS");
    expect(c.downstreamFailureMasked).toBe(false);
    expect(diagnoseOutcome(c, r.transaction.hash)).toEqual([]);
    // tokens burnt total must equal the sum observed live on 4 providers (214838487098800000000 for receipts)
    const t = totals(nodes, r);
    expect(BigInt(t.tokens)).toBeGreaterThan(214838487098800000000n);
  });

  it("contract panic at root → EXECUTED_FAILURE with high-confidence CONTRACT_EXECUTION_FAILURE", () => {
    const r = fixture("tx-failure-panic.json");
    const { nodes } = buildReceiptTree(r);
    const c = classifyFound(r, nodes);
    expect(c.state).toBe("EXECUTED_FAILURE");
    const d = diagnoseOutcome(c, r.transaction.hash);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe("CONTRACT_EXECUTION_FAILURE");
    expect(d[0]!.explanation).toContain("Market has not expired");
    expect(d[0]!.retry).toBe("safe"); // no side effects: the only real receipt failed atomically
    expect(d[0]!.evidence[0]!.receiptId).toBe(c.failed[0]!.receiptId);
  });

  it("root succeeded, downstream ft_burn + ft_transfer_call failed → PARTIALLY_COMPLETED", () => {
    const r = fixture("tx-partial.json");
    const { root, nodes } = buildReceiptTree(r);
    expect(root?.actions[0]?.methodName).toBe("run_buyback");
    expect(root?.status).toBe("SUCCESS");
    expect(root?.children.map((c) => c.actions[0]?.methodName ?? c.actions[0]?.type)).toEqual([
      "ft_burn",
      "ft_transfer_call",
      "Transfer",
    ]);
    const c = classifyFound(r, nodes);
    expect(c.state).toBe("PARTIALLY_COMPLETED");
    expect(c.failed.map((n) => n.executorId)).toEqual(["token.amstr-admin-zxlhcx.testnet", "token.amstr-admin-zxlhcx.testnet"]);
    const d = diagnoseOutcome(c, r.transaction.hash);
    expect(d.every((x) => x.retry === "unsafe")).toBe(true);
    expect(d[0]!.code).toBe("RECEIPT_EXECUTION_FAILURE");
    expect(d[0]!.title).toMatch(/^Downstream:/);
    expect(d[0]!.suggestedAction).toContain("treasury.amstr-admin-zxlhcx.testnet");
  });

  it("synthetic: pending receipt → INCLUDED + RECEIPTS_PENDING", () => {
    const r = structuredClone(fixture("tx-partial.json"));
    r.final_execution_status = "INCLUDED"; // synthetic
    r.receipts_outcome = r.receipts_outcome.filter((o) => o.outcome.executor_id !== "token.amstr-admin-zxlhcx.testnet"); // synthetic: children not executed yet
    const { nodes } = buildReceiptTree(r);
    const c = classifyFound(r, nodes);
    expect(c.state).toBe("INCLUDED");
    expect(diagnoseOutcome(c, "x").some((d) => d.code === "RECEIPTS_PENDING")).toBe(true);
  });

  it("synthetic: success top-level with a failed callback → DOWNSTREAM_FAILURE_MASKED", () => {
    const r = structuredClone(fixture("tx-partial.json"));
    r.status = { SuccessValue: "" }; // synthetic: callback swallowed the failure
    const { nodes } = buildReceiptTree(r);
    const c = classifyFound(r, nodes);
    expect(c.downstreamFailureMasked).toBe(true);
    expect(diagnoseOutcome(c, "x").map((d) => d.code)).toContain("DOWNSTREAM_FAILURE_MASKED");
  });

  it("digest is stable and sensitive to outcome changes", () => {
    const r = fixture("tx-partial.json");
    const r2 = structuredClone(r);
    (r2.receipts_outcome[0]!.outcome as any).metadata = { gas_profile: "differs" };
    expect(outcomeDigest(r)).toBe(outcomeDigest(r2));
    const r3 = structuredClone(r);
    r3.status = { SuccessValue: "" };
    expect(outcomeDigest(r)).not.toBe(outcomeDigest(r3));
  });

  it("flattenFailure walks the nested nearcore enum", () => {
    const f = flattenFailure({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "boom" } } } });
    expect(f.path).toEqual(["ActionError", "FunctionCallError", "ExecutionError"]);
    expect(f.message).toBe("boom");
  });

  it("tree builder survives the plain `tx` method (no receipt bodies)", () => {
    const r = structuredClone(fixture("tx-partial.json"));
    delete r.receipts;
    const { nodes } = buildReceiptTree(r);
    expect(nodes.length).toBe(8);
    expect(nodes.every((n) => n.actions.length === 0 && n.isRefund === false)).toBe(true);
  });
});

describe("signed transaction decoding", () => {
  it("derives hash, signer, nonce, key and block hash", () => {
    const s = makeSignedTx({ nonce: 777n });
    const d = decodeSignedTx(s.base64);
    expect(d.hash).toBe(s.hash);
    expect(d.nonce).toBe(777n);
    expect(d.publicKey).toBe(s.publicKey);
    expect(d.blockHash).toBe(s.blockHash);
    expect(d.signerId).toBe("alice.testnet");
  });
  it("rejects garbage", () => {
    expect(() => decodeSignedTx("aGVsbG8=")).toThrow(/implausible length/);
    expect(() => decodeSignedTx(Buffer.alloc(200, 7).toString("base64"))).toThrow(/decode/i);
  });
});
