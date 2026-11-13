/**
 * Real-transaction proof on TESTNET: Sentinel predicts each Vault payment before it is sent, then the real
 * `spend` is sent and the contract's answer is compared with the prediction. Also proves Guard pay-once with
 * real money (a retried intent is refused with DUPLICATE_INTENT and the deposit refunded).
 *
 * Uses ONLY the existing payer key from contracts/guard/.env (no key is generated); owner = agent = the payer,
 * on a separate allowance from the dashboard demo. Dry run by default; `--i-confirm` sends.
 *
 *   pnpm proof:testnet                         # dry run: prints the plan, signs nothing
 *   pnpm proof:testnet -- --i-confirm          # send
 *   pnpm proof:testnet -- --i-confirm --out r.json   # also write the results as JSON
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NearSentinel } from "@near-sentinel/sdk";
import { actions, awaitFinal, keyPairFrom, loadEnvFile, NEAR, rpc, signAndSend, TGAS, toNear, view, type TxOutcome } from "./near.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(here, "..", ".env"));
const CONFIRM = process.argv.includes("--i-confirm");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : undefined;
const url = process.env.GUARD_RPC_URL ?? "https://test.rpc.fastnear.com";
const payerId = process.env.GUARD_TEST_PAYER_ACCOUNT_ID ?? "";
const payerKey = process.env.GUARD_TEST_PAYER_PRIVATE_KEY ?? "";
const receiverId = process.env.GUARD_TEST_RECEIVER_ACCOUNT_ID ?? "";
const vaultId = process.env.VAULT_CONTRACT_ID || `vault.${payerId}`;
const guardId = process.env.GUARD_CONTRACT_ID || `guard.${payerId}`;
// A lookalike payee a prompt-injected agent might be told to pay; never on the allowlist, so the contract refuses it
// and no funds move. Default: a lookalike of the original test owner; set PROOF_LOOKALIKE to one of your own payer.
const LOOKALIKE = process.env.PROOF_LOOKALIKE || "kari0s.testnet";

const fail = (m: string): never => {
  console.error(`✕ ${m}`);
  process.exit(1);
};
if (!payerId || !payerKey || !receiverId) fail("Fill GUARD_TEST_PAYER_ACCOUNT_ID, GUARD_TEST_PAYER_PRIVATE_KEY and GUARD_TEST_RECEIVER_ACCOUNT_ID in contracts/guard/.env.");
if (!vaultId.endsWith(`.${payerId}`)) fail(`${vaultId} must be a sub-account of ${payerId}.`);
if (!guardId.endsWith(`.${payerId}`)) fail(`${guardId} must be a sub-account of ${payerId}.`);
const status = await rpc(url, "status", []).catch((e) => fail(`Could not reach ${url}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing: ${url} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);

const mN = (milli: number) => (BigInt(milli) * NEAR) / 1000n; // milliNEAR -> yoctoNEAR
const GAS = 60n * TGAS;
const PER_PAYMENT = 10; // milliNEAR
const DAILY = 30;
const DEPOSIT = 60;
const GUARD_PAY = 5;

interface Step {
  name: string;
  receiver: () => string;
  milli: number;
  intent: string; // suffix; the same suffix means the same intent ID
}
const STEPS: Step[] = [
  { name: "pay 0.005 to the allowed payee", receiver: () => receiverId, milli: 5, intent: "a" },
  { name: "same intent ID again (a blind retry)", receiver: () => receiverId, milli: 5, intent: "a" },
  { name: `prompt-injected lookalike ${LOOKALIKE}`, receiver: () => LOOKALIKE, milli: 5, intent: "x" },
  { name: "0.02, over the per-payment limit", receiver: () => receiverId, milli: 20, intent: "y" },
  { name: "pay the vault itself", receiver: () => vaultId, milli: 5, intent: "z" },
  { name: "amount 0", receiver: () => receiverId, milli: 0, intent: "w" },
  { name: "pay 0.01 (new intent)", receiver: () => receiverId, milli: 10, intent: "b" },
  { name: "pay 0.01 (new intent)", receiver: () => receiverId, milli: 10, intent: "c" },
  { name: "pay 0.01 (new intent)", receiver: () => receiverId, milli: 10, intent: "d" },
];
const FROZEN_STEP: Step = { name: "pay 0.001 while frozen", receiver: () => receiverId, milli: 1, intent: "e" };

console.log("━━ Real-transaction proof — TESTNET ━━");
console.log(`network : testnet (verified via ${url} status.chain_id)`);
console.log(`owner   : ${payerId} (also the agent: a separate allowance from the dashboard demo; key from .env, not shown)`);
console.log(`payee   : ${receiverId}`);
console.log(`vault   : ${vaultId} · guard: ${guardId}`);
console.log(`policy  : set_policy(per payment ${toNear(mN(PER_PAYMENT))}, 24 h ${toNear(mN(DAILY))}, only ${receiverId}) with a ${toNear(mN(DEPOSIT))} NEAR deposit`);
console.log("vault steps (Sentinel predicts each one, then the real spend() is sent):");
for (const s of [...STEPS, FROZEN_STEP]) console.log(`  - ${s.name}`);
console.log("  then: retry-check on the first real payment, get_spend, unfreeze, withdraw the remaining balance back to the owner");
console.log(`guard steps: pay ${toNear(mN(GUARD_PAY))} NEAR once, retry the same intent (must be DUPLICATE_INTENT, deposit refunded), check_intent before/after`);
console.log(
  `max moved: at most ${toNear(mN(DAILY))} NEAR from the vault (the 24-hour limit) + ${toNear(mN(GUARD_PAY))} NEAR via the guard reach ${receiverId}; ` +
    `0.006 NEAR record fee per successful spend, the guard storage fee and gas. The rest of the deposit is withdrawn back.`,
);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm.");
  process.exit(0);
}

const owner = { accountId: payerId, keyPair: keyPairFrom(payerKey, "GUARD_TEST_PAYER_PRIVATE_KEY") };
const agentId = payerId;
const sentinel = new NearSentinel({ network: "testnet" });
const call = (method: string, args: object, deposit = 0n) => signAndSend(url, owner, vaultId, [actions.functionCall(method, args, GAS, deposit)]);
const policy = () => view(url, vaultId, "get_policy", { owner_id: payerId, agent_id: agentId });
const CODES = ["INVALID_INTENT_ID", "INVALID_AMOUNT", "INVALID_RECEIVER", "DUPLICATE_INTENT", "NO_POLICY", "FROZEN", "NOT_ALLOWED_RECEIVER", "OVER_PER_PAYMENT_LIMIT", "OVER_DAILY_LIMIT", "INSUFFICIENT_VAULT_BALANCE"];
const codeOf = (o: TxOutcome) => (o.ok ? null : (CODES.find((c) => (o.failure + o.receiptFailures.join(" ")).includes(c)) ?? "OTHER:" + o.failure.slice(0, 120)));
const tx = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

const start = await policy();
if (start?.frozen) await call("set_frozen", { agent_id: agentId, frozen: false });
const setp = await call("set_policy", { agent_id: agentId, per_payment_max: String(mN(PER_PAYMENT)), daily_max: String(mN(DAILY)), allowed_receivers: [receiverId] }, mN(DEPOSIT));
console.log(`set_policy: ${setp.ok ? "ok" : setp.failure} ${tx(setp.hash)}`);
if (!setp.ok) process.exit(1);

const run = Date.now().toString(36);
interface Row {
  name: string;
  predicted: string;
  action: string;
  receiverCheck: string;
  actual: string;
  match: boolean;
  tx: string;
}
const rows: Row[] = [];
async function step(s: Step): Promise<TxOutcome> {
  const receiver = s.receiver();
  const intent = `rt-${run}-${s.intent}`;
  const amount = String(mN(s.milli));
  const pre = await sentinel.preflightSpend({ contractId: vaultId, ownerId: payerId, agentId, receiverId: receiver, amountYocto: amount, intentId: intent });
  const o = await call("spend", { owner_id: payerId, intent_id: intent, receiver_id: receiver, amount });
  const actual = codeOf(o);
  const predicted = pre.decision === "ALLOWED" ? null : pre.decision === "BLOCKED" ? (pre.code ?? "BLOCKED") : "UNKNOWN";
  const row: Row = {
    name: s.name,
    predicted: predicted ?? "ALLOWED",
    action: pre.action,
    receiverCheck: pre.receiverCheck?.status ?? "-",
    actual: actual ?? "PAID",
    match: predicted === actual,
    tx: o.hash,
  };
  rows.push(row);
  console.log(`${row.match ? "MATCH   " : "MISMATCH"} ${s.name.padEnd(40)} Sentinel: ${row.predicted.padEnd(24)} action: ${row.action.padEnd(9)} contract: ${row.actual.padEnd(24)} ${tx(o.hash)}`);
  return o;
}

const first = await step(STEPS[0]!);
for (const s of STEPS.slice(1)) await step(s);
const fr = await call("set_frozen", { agent_id: agentId, frozen: true });
console.log(`freeze: ${fr.ok ? "ok" : fr.failure} ${tx(fr.hash)}`);
await step(FROZEN_STEP);
const uf = await call("set_frozen", { agent_id: agentId, frozen: false });
console.log(`unfreeze: ${uf.ok ? "ok" : uf.failure} ${tx(uf.hash)}`);

// The core feature on a real payment: did it land? (what an agent whose reply timed out would ask)
const verdict = await sentinel.checkRetrySafety({ transactionHash: first.hash, senderAccountId: payerId });
console.log(`retry-check on the first real payment: ${verdict.verdict}`);
const rec = await view(url, vaultId, "get_spend", { owner_id: payerId, agent_id: agentId, intent_id: `rt-${run}-a` });
console.log(`get_spend(rt-${run}-a): ${rec ? `${rec.status} ${toNear(BigInt(rec.amount))} NEAR to ${rec.receiver_id}` : "none"}`);
const rest = BigInt((await policy()).balance);
const wd = await call("withdraw", { agent_id: agentId, amount: String(rest) });
console.log(`withdraw ${toNear(rest)} NEAR back to ${payerId}: ${wd.ok ? "ok" : wd.failure} ${tx(wd.hash)}`);

// ---------------- Guard: pay once per intent, real money ----------------
const fee = BigInt(await view(url, guardId, "storage_fee", {}));
const gIntent = `rt-${run}-g`;
const guardRows: Array<{ name: string; value: string; ok: boolean; tx?: string }> = [];
const g0 = await sentinel.checkIntent({ contractId: guardId, payerId, intentId: gIntent });
guardRows.push({ name: "before paying: intent status", value: g0.status, ok: g0.status === "NOT_RECORDED" });
const payArgs = { intent_id: gIntent, receiver_id: receiverId };
const pay = await signAndSend(url, owner, guardId, [actions.functionCall("pay", payArgs, GAS, mN(GUARD_PAY) + fee)]);
guardRows.push({ name: `guard pay ${toNear(mN(GUARD_PAY))} to the payee`, value: pay.ok ? "PAID" : pay.failure.slice(0, 80), ok: pay.ok, tx: pay.hash });
const g1 = await sentinel.checkIntent({ contractId: guardId, payerId, intentId: gIntent });
guardRows.push({ name: "after paying: intent status", value: g1.status, ok: g1.status === "PAID" });
const v1 = await sentinel.checkRetrySafety({ transactionHash: pay.hash, senderAccountId: payerId });
guardRows.push({ name: "did it land? (retry-check on the pay tx)", value: v1.verdict, ok: v1.verdict === "DO_NOT_RETRY" });
const dup = await signAndSend(url, owner, guardId, [actions.functionCall("pay", payArgs, GAS, mN(GUARD_PAY) + fee)]);
const dupFull = dup.ok ? dup : await awaitFinal(url, dup.hash, payerId);
const refunded = (dupFull.raw?.receipts ?? []).some(
  (r: any) => r.receiver_id === payerId && (r.receipt?.Action?.actions ?? []).some((a: any) => a.Transfer && BigInt(a.Transfer.deposit) >= mN(GUARD_PAY)),
);
const dupCode = dup.ok ? "PAID TWICE!" : dup.failure.includes("DUPLICATE_INTENT") ? "DUPLICATE_INTENT" : dup.failure.slice(0, 60);
guardRows.push({ name: "same intent again (a retry)", value: `${dupCode}${refunded ? ", deposit refunded" : ", refund NOT found"}`, ok: !dup.ok && dup.failure.includes("DUPLICATE_INTENT") && refunded, tx: dup.hash });
const g2 = await sentinel.checkIntent({ contractId: guardId, payerId, intentId: gIntent });
guardRows.push({ name: "after the retry: still paid once", value: g2.status, ok: g2.status === "PAID" });
const guardOk = guardRows.every((r) => r.ok);

const matched = rows.filter((r) => r.match).length;
console.log("\n### Vault: Sentinel's prediction vs the contract\n");
console.log("| Step | Sentinel predicted | Agent action | Receiver check | Contract did | Match | Tx |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.predicted} | ${r.action} | ${r.receiverCheck} | ${r.actual} | ${r.match ? "yes" : "**NO**"} | [${r.tx.slice(0, 8)}…](${tx(r.tx)}) |`);
console.log("\n### Guard: pay once\n");
console.log("| Step | Result | Pass | Tx |");
console.log("|---|---|---|---|");
for (const r of guardRows) console.log(`| ${r.name} | ${r.value} | ${r.ok ? "yes" : "**NO**"} | ${r.tx ? `[${r.tx.slice(0, 8)}…](${tx(r.tx)})` : ""} |`);
console.log(`\n${matched}/${rows.length} predictions matched the contract · retry-check ${verdict.verdict} · guard ${guardOk ? "PASS" : "FAIL"}`);
if (OUT) {
  writeFileSync(OUT, JSON.stringify({ run, rows, guardRows, verdict: verdict.verdict, first: first.hash, setPolicy: setp.hash, freeze: fr.hash, unfreeze: uf.hash, withdraw: wd.hash }, null, 1));
  console.log(`results written to ${OUT}`);
}
process.exit(matched === rows.length && verdict.verdict === "DO_NOT_RETRY" && wd.ok && guardOk ? 0 : 1);
