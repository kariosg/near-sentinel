/**
 * On-chain checks for Sentinel Vault. The agent spends with a FUNCTION-CALL access key that can only call
 * `spend` on the vault, so it can pay within the owner's policy and nothing else.
 * Shared by the local sandbox run (sandbox.ts) and the testnet run (vault-testnet.ts).
 */
import { KeyPair } from "near-api-js";
import { actions, awaitFinal, balance, NEAR, signAndSend, TGAS, toNear, view, type Signer, type TxOutcome } from "./near.js";
import type { CheckResult } from "./suite.js";

export interface VaultEnv {
  rpcUrl: string;
  vaultId: string;
  owner: Signer;
  /** The agent's FULL-ACCESS signer, used once to add the restricted key (sandbox only). */
  agentFull?: Signer;
  /** Or an existing key of the agent (testnet). One of the two is required. */
  agentFc?: Signer;
  /** Skip the checks that need a restricted (function-call) key: used on testnet, where no key is generated. */
  skipRestrictedKeyChecks?: boolean;
  shopId: string;
  /** Named account that does not exist (transfer must fail and be restored). */
  missingId: string;
  /** An account that is not on the allowlist. */
  outsiderId: string;
  /** An account other than the owner (tries to withdraw). */
  intruder?: Signer;
  runId: string;
  /** Unit for amounts (1 = 1 NEAR in the sandbox; smaller on testnet). */
  unit: bigint;
  explorer?: (hash: string) => string;
}

const GAS = 60n * TGAS;
const frac = (unit: bigint, n: number) => (unit * BigInt(Math.round(n * 1000))) / 1000n;

export async function runVaultSuite(e: VaultEnv): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, pass: boolean, detail: string, txs: TxOutcome[] = []) => {
    results.push({ name: `vault: ${name}`, pass, detail, tx: txs.map((t) => t.hash) });
    console.log(`${pass ? "PASS" : "FAIL"}  vault: ${name} — ${detail}${txs.length && e.explorer ? `\n        ${txs.map((t) => e.explorer!(t.hash)).join("\n        ")}` : ""}`);
    if (!pass) for (const t of txs) console.log(`        tx ${t.hash}: ${(t.failure || JSON.stringify(t.receiptFailures)).slice(0, 300)}`);
  };
  const U = e.unit;
  const id = (s: string) => `${e.runId}-${s}`;
  const owner = e.owner;
  const agentId = (e.agentFc ?? e.agentFull)!.accountId;
  const policyView = () => view(e.rpcUrl, e.vaultId, "get_policy", { owner_id: owner.accountId, agent_id: agentId });

  // 0. Contract identity.
  const version = await view(e.rpcUrl, e.vaultId, "version", {});
  check("contract answers version", version === "0.1.0", `version ${version}`);

  // A previous run may have left this (owner, agent) policy frozen: unfreeze it first (owner action).
  const prior = await policyView();
  if (prior?.frozen) await signAndSend(e.rpcUrl, owner, e.vaultId, [actions.functionCall("set_frozen", { agent_id: agentId, frozen: false }, GAS, 0n)]);
  const balBefore = prior ? BigInt(prior.balance) : 0n;
  const funding = 3n * U + NEAR / 20n; // + 0.05 NEAR for per-spend record fees

  // 1. Owner creates the policy: per payment 1 U, per day 1.5 U, only the shop (and the missing account, for the failure test).
  const p1 = await signAndSend(e.rpcUrl, owner, e.vaultId, [
    actions.functionCall(
      "set_policy",
      { agent_id: agentId, per_payment_max: String(U), daily_max: String(frac(U, 1.5)), allowed_receivers: [e.shopId, e.missingId] },
      GAS,
      funding,
    ),
  ]);
  const pol = await policyView();
  const credited = pol ? BigInt(pol.balance) - balBefore : 0n;
  check("owner funds a policy (storage paid from the deposit)", p1.ok && !!pol && !pol.frozen && credited > funding - NEAR / 100n && credited <= funding, `credited ${toNear(credited)} of ${toNear(funding)} NEAR (rest paid storage)`, [p1]);

  // 2. The agent gets a key that can ONLY call `spend` on the vault.
  let fc: Signer;
  if (e.agentFc) {
    fc = e.agentFc;
  } else {
    const kp = KeyPair.fromRandom("ed25519"); // sandbox only: in memory, discarded after the run
    const add = await signAndSend(e.rpcUrl, e.agentFull!, agentId, [actions.addFunctionCallAccessKey(kp.getPublicKey(), e.vaultId, ["spend"], NEAR / 4n)]);
    check("agent adds a function-call key limited to vault.spend", add.ok, add.ok ? "key added (receiver = vault, methods = [spend])" : add.failure, [add]);
    fc = { accountId: agentId, keyPair: kp };
  }
  const spend = (intent: string, receiver: string, amount: bigint) =>
    signAndSend(e.rpcUrl, fc, e.vaultId, [actions.functionCall("spend", { owner_id: owner.accountId, intent_id: id(intent), receiver_id: receiver, amount: String(amount) }, GAS, 0n)]);

  // 3. Spend within the policy using only the restricted key.
  let shopBefore = await balance(e.rpcUrl, e.shopId);
  const s1 = await spend("a", e.shopId, frac(U, 0.5));
  let shopAfter = await balance(e.rpcUrl, e.shopId);
  const rec = await view(e.rpcUrl, e.vaultId, "get_spend", { owner_id: owner.accountId, agent_id: agentId, intent_id: id("a") });
  check(e.skipRestrictedKeyChecks ? "agent pays within the policy" : "agent pays with the restricted key", s1.ok && shopAfter - shopBefore === frac(U, 0.5) && rec?.status === "Paid", `shop +${toNear(shopAfter - shopBefore)} NEAR, record ${rec?.status}`, [s1]);

  if (!e.skipRestrictedKeyChecks) {
  // 4. The restricted key cannot move the agent's own funds.
  const direct = await signAndSend(e.rpcUrl, fc, e.shopId, [actions.transfer(frac(U, 0.1))]).catch((err) => ({ hash: "-", ok: false, failure: String(err?.message ?? err), receiptFailures: [], logs: [], raw: null }) as TxOutcome);
  check("the restricted key cannot transfer the agent's own NEAR", !direct.ok, direct.ok ? "TRANSFER WENT THROUGH" : `rejected: ${direct.failure.slice(0, 90)}`);

  // 5. ... nor call any other vault method (e.g. unfreeze itself, or withdraw).
  const other = await signAndSend(e.rpcUrl, fc, e.vaultId, [actions.functionCall("set_frozen", { agent_id: agentId, frozen: false }, GAS, 0n)]).catch((err) => ({ hash: "-", ok: false, failure: String(err?.message ?? err), receiptFailures: [], logs: [], raw: null }) as TxOutcome);
  check("the restricted key cannot call other methods", !other.ok, other.ok ? "CALL WENT THROUGH" : `rejected: ${other.failure.slice(0, 90)}`);
  }

  // 6. Same intent again: rejected, no second payment.
  shopBefore = await balance(e.rpcUrl, e.shopId);
  const dup = await spend("a", e.shopId, frac(U, 0.5));
  shopAfter = await balance(e.rpcUrl, e.shopId);
  check("same intent twice pays once (DUPLICATE_INTENT)", !dup.ok && dup.failure.includes("DUPLICATE_INTENT") && shopAfter === shopBefore, `shop +${toNear(shopAfter - shopBefore)} NEAR`, [dup]);

  // 7. Limits.
  const over = await spend("big", e.shopId, frac(U, 1.1));
  check("over the per-payment limit is rejected", !over.ok && over.failure.includes("OVER_PER_PAYMENT_LIMIT"), "OVER_PER_PAYMENT_LIMIT", [over]);
  const notAllowed = await spend("evil", e.outsiderId, frac(U, 0.1));
  check("a receiver outside the allowlist is rejected", !notAllowed.ok && notAllowed.failure.includes("NOT_ALLOWED_RECEIVER"), "NOT_ALLOWED_RECEIVER", [notAllowed]);
  const s2 = await spend("b", e.shopId, frac(U, 0.9));
  const daily = await spend("c", e.shopId, frac(U, 0.2));
  check("the 24-hour limit holds across payments (0.5 + 0.9, then 0.2 over 1.5)", s2.ok && !daily.ok && daily.failure.includes("OVER_DAILY_LIMIT"), "OVER_DAILY_LIMIT", [s2, daily]);

  // 8. A failed transfer restores balance and allowance and frees the intent.
  const before = await policyView();
  const fail = await spend("lost", e.missingId, frac(U, 0.05));
  await new Promise((r) => setTimeout(r, 2000));
  const after = await policyView();
  const lostRec = await view(e.rpcUrl, e.vaultId, "get_spend", { owner_id: owner.accountId, agent_id: agentId, intent_id: id("lost") });
  check(
    "a failed transfer restores the balance and the daily allowance",
    fail.receiptFailures.length > 0 && lostRec === null && after.balance === before.balance && after.spent_in_window === before.spent_in_window,
    `balance ${toNear(BigInt(before.balance))} → ${toNear(BigInt(after.balance))} NEAR, record ${lostRec === null ? "released" : "STUCK"}`,
    [fail],
  );

  // 9. Owner freezes the agent: nothing can be spent until unfrozen.
  const fr = await signAndSend(e.rpcUrl, owner, e.vaultId, [actions.functionCall("set_frozen", { agent_id: agentId, frozen: true }, GAS, 0n)]);
  const frozenSpend = await spend("frozen", e.shopId, frac(U, 0.01));
  const frozenView = await policyView();
  check("owner freezes the agent (FROZEN, available_now 0)", fr.ok && !frozenSpend.ok && frozenSpend.failure.includes("FROZEN") && frozenView.available_now === "0", "FROZEN", [fr, frozenSpend]);
  await signAndSend(e.rpcUrl, owner, e.vaultId, [actions.functionCall("set_frozen", { agent_id: agentId, frozen: false }, GAS, 0n)]); // leave it usable

  // 10. Only the owner can withdraw.
  if (e.intruder) {
    const steal = await signAndSend(e.rpcUrl, e.intruder, e.vaultId, [actions.functionCall("withdraw", { agent_id: agentId, amount: String(frac(U, 0.1)) }, GAS, 0n)]);
    check("another account cannot withdraw the allowance", !steal.ok && steal.failure.includes("NO_POLICY"), "NO_POLICY", [steal]);
  }
  const rest = BigInt((await policyView()).balance);
  const wd = await signAndSend(e.rpcUrl, owner, e.vaultId, [actions.functionCall("withdraw", { agent_id: agentId, amount: String(rest) }, GAS, 0n)]);
  const finalView = await policyView();
  // Evidence from the chain itself: a Transfer receipt of exactly `rest` to the owner (balance deltas are skewed by gas refunds).
  const wdFull = wd.ok ? await awaitFinal(e.rpcUrl, wd.hash, owner.accountId) : wd;
  const paidOut = (wdFull.raw?.receipts ?? []).some(
    (r: any) => r.receiver_id === owner.accountId && (r.receipt?.Action?.actions ?? []).some((a: any) => a.Transfer && BigInt(a.Transfer.deposit) === rest),
  );
  check("owner withdraws the remaining balance", wd.ok && finalView.balance === "0" && paidOut, `transfer of ${toNear(rest)} NEAR to ${owner.accountId} ${paidOut ? "found on-chain" : "NOT FOUND"}`, [wd]);
  return results;
}
