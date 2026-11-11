/**
 * End-to-end checks for a DEPLOYED Sentinel Guard contract. The same suite runs against a local
 * sandbox (sandbox.ts) and against testnet (integration-testnet.ts).
 */
import { NearSentinel } from "@near-sentinel/sdk";
import { actions, awaitFinal, balance, NEAR, signAndSend, TGAS, toNear, view, type Signer, type TxOutcome } from "./near.js";

export interface SuiteEnv {
  rpcUrl: string;
  contractId: string;
  payer: Signer;
  /** Optional second payer (independence check). */
  payer2?: Signer;
  receiverId: string;
  /** Named account that does not exist (transfer must fail and be refunded). */
  missingReceiverId: string;
  /** Per-payment amount, yocto. */
  amount: bigint;
  /** Unique run id so intent IDs never collide across runs. */
  runId: string;
  explorer?: (txHash: string) => string;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  tx?: string[];
}

const STORAGE_FEE = 5n * 10n ** 21n; // 0.005 NEAR
const PAY_GAS = 50n * TGAS;
const GAS_SLACK = 5n * 10n ** 21n; // payer cost from gas alone stays well under 0.005 NEAR per tx

export async function runSuite(e: SuiteEnv): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, pass: boolean, detail: string, txs: TxOutcome[] = []) => {
    results.push({ name, pass, detail, tx: txs.map((t) => t.hash) });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}${txs.length && e.explorer ? `\n        ${txs.map((t) => e.explorer!(t.hash)).join("\n        ")}` : ""}`);
    if (!pass)
      for (const t of txs)
        console.log(
          `        tx ${t.hash}: status=${JSON.stringify(t.raw?.status ?? t.raw?.error ?? null).slice(0, 300)} receipts=${JSON.stringify((t.raw?.receipts_outcome ?? []).map((o: any) => o.outcome?.status)).slice(0, 400)}`,
        );
  };
  const pay = (signer: Signer, intentId: string, receiverId: string, deposit: bigint) =>
    signAndSend(e.rpcUrl, signer, e.contractId, [actions.functionCall("pay", { intent_id: intentId, receiver_id: receiverId }, PAY_GAS, deposit)]);
  const deposit = e.amount + STORAGE_FEE;
  const id = (s: string) => `${e.runId}-${s}`;

  // 0. The contract is a Sentinel Guard.
  const version = await view(e.rpcUrl, e.contractId, "version", {});
  const fee = await view(e.rpcUrl, e.contractId, "storage_fee", {});
  check("contract answers version + storage_fee", version === "0.1.0" && BigInt(fee) === STORAGE_FEE, `version ${version}, storage_fee ${toNear(BigInt(fee))} NEAR`);

  // 1. First payment goes through exactly once.
  let rBefore = await balance(e.rpcUrl, e.receiverId);
  const p1 = await pay(e.payer, id("a"), e.receiverId, deposit);
  let rAfter = await balance(e.rpcUrl, e.receiverId);
  let rec = await view(e.rpcUrl, e.contractId, "get_intent", { payer_id: e.payer.accountId, intent_id: id("a") });
  check(
    "first pay() forwards the amount and records the intent as Paid",
    p1.ok && rAfter - rBefore === e.amount && rec?.status === "Paid" && p1.logs.some((l) => l.includes('"event":"intent_paid"')),
    `receiver +${toNear(rAfter - rBefore)} NEAR (expected ${toNear(e.amount)}), status ${rec?.status}`,
    [p1],
  );

  // 2. Same intent again → rejected on-chain, deposit refunded, receiver unchanged.
  let payerBefore = await balance(e.rpcUrl, e.payer.accountId);
  rBefore = rAfter;
  const p2 = await pay(e.payer, id("a"), e.receiverId, deposit);
  rAfter = await balance(e.rpcUrl, e.receiverId);
  let payerAfter = await balance(e.rpcUrl, e.payer.accountId);
  check(
    "duplicate pay() with the same intent is rejected (DUPLICATE_INTENT), deposit refunded",
    !p2.ok && p2.failure.includes("DUPLICATE_INTENT") && rAfter === rBefore && payerBefore - payerAfter < GAS_SLACK,
    `receiver +${toNear(rAfter - rBefore)}, payer spent ${toNear(payerBefore - payerAfter)} NEAR (gas only)`,
    [p2],
  );

  // 3. Transfer to a missing account → intent released and the full deposit refunded.
  payerBefore = await balance(e.rpcUrl, e.payer.accountId);
  const p3 = await pay(e.payer, id("b"), e.missingReceiverId, deposit);
  payerAfter = await balance(e.rpcUrl, e.payer.accountId);
  rec = await view(e.rpcUrl, e.contractId, "get_intent", { payer_id: e.payer.accountId, intent_id: id("b") });
  check(
    "failed transfer releases the intent and refunds the full deposit",
    rec === null && p3.receiptFailures.length > 0 && p3.logs.some((l) => l.includes('"event":"intent_released"')) && payerBefore - payerAfter < GAS_SLACK,
    `record ${rec === null ? "released" : "STILL PRESENT"}, payer spent ${toNear(payerBefore - payerAfter)} NEAR (gas only)`,
    [p3],
  );

  // 4. The released intent can be paid again.
  rBefore = await balance(e.rpcUrl, e.receiverId);
  const p4 = await pay(e.payer, id("b"), e.receiverId, deposit);
  rAfter = await balance(e.rpcUrl, e.receiverId);
  check("a released intent can be paid again", p4.ok && rAfter - rBefore === e.amount, `receiver +${toNear(rAfter - rBefore)} NEAR`, [p4]);

  // 5. Callback is private.
  const p5 = await signAndSend(e.rpcUrl, e.payer, e.contractId, [
    actions.functionCall("on_transfer", { payer_id: e.payer.accountId, intent_id: id("a") }, 20n * TGAS, 0n),
  ]);
  check("on_transfer cannot be called by anyone but the contract", !p5.ok && /private/i.test(p5.failure), "rejected as private", [p5]);

  // 6. Input validation.
  const p6 = await pay(e.payer, id("c"), e.receiverId, STORAGE_FEE);
  check("deposit must exceed the storage fee", !p6.ok && p6.failure.includes("INSUFFICIENT_DEPOSIT"), "INSUFFICIENT_DEPOSIT", [p6]);
  const p7 = await pay(e.payer, 'bad"id', e.receiverId, deposit);
  check("intent ids with quotes are rejected (event JSON can't be forged)", !p7.ok && p7.failure.includes("INVALID_INTENT_ID"), "INVALID_INTENT_ID", [p7]);
  const p8 = await pay(e.payer, id("d"), e.contractId, deposit);
  check("cannot pay the guard contract itself", !p8.ok && p8.failure.includes("INVALID_RECEIVER"), "INVALID_RECEIVER", [p8]);

  // 7. Two concurrent pay() calls for the same intent → the receiver is credited exactly once.
  rBefore = await balance(e.rpcUrl, e.receiverId);
  // Two DIFFERENT transactions (nonce +1 and +2), broadcast back to back without waiting, so both
  // are in flight at the same time and the contract alone decides which one pays.
  const raceAct = () => [actions.functionCall("pay", { intent_id: id("race"), receiver_id: e.receiverId }, PAY_GAS, deposit)];
  const b1 = await signAndSend(e.rpcUrl, e.payer, e.contractId, raceAct(), "NONE", 1n);
  const b2 = await signAndSend(e.rpcUrl, e.payer, e.contractId, raceAct(), "NONE", 2n);
  const [c1, c2] = await Promise.all([awaitFinal(e.rpcUrl, b1.hash, e.payer.accountId), awaitFinal(e.rpcUrl, b2.hash, e.payer.accountId)]);
  rAfter = await balance(e.rpcUrl, e.receiverId);
  check(
    "two concurrent pay() calls for one intent credit the receiver exactly once",
    c1.hash !== c2.hash && rAfter - rBefore === e.amount && [c1, c2].filter((x) => x.ok).length === 1 && [c1, c2].some((x) => x.failure.includes("DUPLICATE_INTENT")),
    `receiver +${toNear(rAfter - rBefore)} NEAR; outcomes: ${[c1, c2].map((x) => (x.ok ? "ok" : x.failure.includes("DUPLICATE_INTENT") ? "DUPLICATE_INTENT" : "rejected")).join(", ")}`,
    [c1, c2],
  );

  // 8. Same intent id from a different payer is independent.
  if (e.payer2) {
    const p9 = await pay(e.payer2, id("a"), e.receiverId, deposit);
    check("the same intent id from another payer is independent", p9.ok, p9.ok ? "paid" : p9.failure, [p9]);
  }

  // 9. NEAR Sentinel (read-only SDK) sees the contract's records.
  const sentinel = new NearSentinel({ rpcProviders: [{ name: "rpc", url: e.rpcUrl, operator: "rpc" }] });
  const paid = await sentinel.checkIntent({ contractId: e.contractId, payerId: e.payer.accountId, intentId: id("a") });
  const never = await sentinel.checkIntent({ contractId: e.contractId, payerId: e.payer.accountId, intentId: id("never") });
  check(
    "Sentinel checkIntent: PAID for a paid intent, NOT_RECORDED for an unused one",
    paid.status === "PAID" && never.status === "NOT_RECORDED",
    `${paid.status} / ${never.status}`,
  );

  return results;
}

export function summarize(results: CheckResult[]): boolean {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join("; ")}` : ""}`);
  return failed.length === 0;
}

export const near = (n: number) => BigInt(Math.round(n * 1e6)) * (NEAR / 1_000_000n);
