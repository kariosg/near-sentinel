/**
 * Live integration test against the DEPLOYED guard on TESTNET, using accounts YOU control.
 * Keys come only from contracts/guard/.env (git-ignored) and are never printed.
 *
 *   pnpm --filter @near-sentinel/guard test:testnet                 # dry run (plan + balances)
 *   pnpm --filter @near-sentinel/guard test:testnet -- --i-confirm  # sends the test transactions
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { balance, keyPairFrom, loadEnvFile, rpc, toNear } from "./near.js";
import { near, runSuite, summarize } from "./suite.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(here, "..", ".env"));
const CONFIRM = process.argv.includes("--i-confirm");
const url = process.env.GUARD_RPC_URL ?? "https://test.rpc.fastnear.com";
const contractId = process.env.GUARD_CONTRACT_ID ?? "";
const payerId = process.env.GUARD_TEST_PAYER_ACCOUNT_ID ?? "";
const payerKey = process.env.GUARD_TEST_PAYER_PRIVATE_KEY ?? "";
const receiverId = process.env.GUARD_TEST_RECEIVER_ACCOUNT_ID ?? "";
const AMOUNT = near(0.01);
// Payments that actually reach the receiver: first pay, re-pay of released intent, one race winner.
const MAX_SPEND = AMOUNT * 3n;

const fail = (m: string): never => {
  console.error(`✕ ${m}`);
  process.exit(1);
};
if (!contractId || !payerId || !payerKey || !receiverId) fail("Fill GUARD_CONTRACT_ID, GUARD_TEST_PAYER_ACCOUNT_ID, GUARD_TEST_PAYER_PRIVATE_KEY and GUARD_TEST_RECEIVER_ACCOUNT_ID in contracts/guard/.env.");
for (const a of [contractId, payerId, receiverId]) if (!a.endsWith(".testnet")) fail(`${a} is not a .testnet account.`);
if (payerId === receiverId) fail("Payer and receiver must differ.");
const status = await rpc(url, "status", []).catch((e) => fail(`Could not reach ${url}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing: ${url} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);

const payer = { accountId: payerId, keyPair: keyPairFrom(payerKey, "GUARD_TEST_PAYER_PRIVATE_KEY") };
const payerBal = await balance(url, payerId);
const runId = `t${Date.now().toString(36)}`;

console.log("━━ Sentinel Guard — LIVE TESTNET integration test ━━");
console.log(`contract : ${contractId}`);
console.log(`payer    : ${payerId}  balance ${toNear(payerBal)} NEAR`);
console.log(`receiver : ${receiverId}`);
console.log(`plan     : ~12 transactions; ${toNear(AMOUNT)} NEAR per payment; at most ${toNear(MAX_SPEND)} NEAR reaches the receiver, plus gas`);
if (payerBal < MAX_SPEND + 10n ** 24n) fail(`Payer balance too low; keep ≥ ${toNear(MAX_SPEND + 10n ** 24n)} NEAR.`);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm to execute.");
  process.exit(0);
}

const results = await runSuite({
  rpcUrl: url,
  contractId,
  payer,
  receiverId,
  missingReceiverId: `sentinel-nobody-${runId}.testnet`,
  amount: AMOUNT,
  runId,
  explorer: (h) => `https://testnet.nearblocks.io/txns/${h}`,
});
process.exit(summarize(results) ? 0 : 1);
