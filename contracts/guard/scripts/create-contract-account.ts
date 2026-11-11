/**
 * Create the Guard's contract account on TESTNET as a sub-account of the payer, WITHOUT generating any key:
 * the new account gets the payer's existing public key as its FullAccess key, so the same owner controls it.
 * Keys are read only from contracts/guard/.env (git-ignored) and never printed.
 *
 *   pnpm --filter @near-sentinel/guard create-account                 # dry run
 *   pnpm --filter @near-sentinel/guard create-account -- --i-confirm  # CreateAccount + Transfer + AddKey
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountExists, actions, balance, keyPairFrom, loadEnvFile, NEAR, rpc, signAndSend, toNear } from "./near.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(here, "..", ".env"));
const CONFIRM = process.argv.includes("--i-confirm");
const url = process.env.GUARD_RPC_URL ?? "https://test.rpc.fastnear.com";
const contractId = process.env.GUARD_CONTRACT_ID ?? "";
const payerId = process.env.GUARD_TEST_PAYER_ACCOUNT_ID ?? "";
const payerKey = process.env.GUARD_TEST_PAYER_PRIVATE_KEY ?? "";
const FUND = 5n * NEAR;

const fail = (m: string): never => {
  console.error(`✕ ${m}`);
  process.exit(1);
};
if (!contractId || !payerId || !payerKey) fail("Fill GUARD_CONTRACT_ID, GUARD_TEST_PAYER_ACCOUNT_ID and GUARD_TEST_PAYER_PRIVATE_KEY in contracts/guard/.env.");
if (!payerId.endsWith(".testnet")) fail(`${payerId} is not a .testnet account.`);
if (!contractId.endsWith(`.${payerId}`)) fail(`${contractId} must be a sub-account of ${payerId} (e.g. guard.${payerId}).`);
const status = await rpc(url, "status", []).catch((e) => fail(`Could not reach ${url}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing: ${url} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);

const keyPair = keyPairFrom(payerKey, "GUARD_TEST_PAYER_PRIVATE_KEY");
const publicKey = keyPair.getPublicKey();
const ak = await rpc(url, "query", { request_type: "view_access_key", finality: "final", account_id: payerId, public_key: publicKey.toString() });
if (ak.error || ak.result?.error) fail(`The payer key in .env is not an access key of ${payerId}.`);
if (ak.result.permission !== "FullAccess") fail("Creating a sub-account needs a FullAccess key of the payer.");
if (await accountExists(url, contractId)) fail(`${contractId} already exists; nothing to create.`);
const bal = await balance(url, payerId);

console.log("━━ Create Guard contract account — TESTNET ━━");
console.log(`network   : testnet (verified via ${url} status.chain_id)`);
console.log(`signer    : ${payerId}  balance ${toNear(bal)} NEAR`);
console.log(`new acct  : ${contractId}`);
console.log(`actions   : CreateAccount + Transfer ${toNear(FUND)} NEAR + AddKey(${publicKey.toString().slice(0, 16)}…, FullAccess)`);
console.log("key       : the payer's EXISTING public key; no new key is generated");
if (bal < FUND + NEAR) fail(`Payer balance too low; keep ≥ ${toNear(FUND + NEAR)} NEAR.`);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm to create the account.");
  process.exit(0);
}

const r = await signAndSend(url, { accountId: payerId, keyPair }, contractId, [
  actions.createAccount(),
  actions.transfer(FUND),
  actions.addFullAccessKey(publicKey),
]);
if (!r.ok) fail(`Create failed (tx ${r.hash}): ${r.failure}`);
const after = await balance(url, contractId);
console.log(`\n✓ created — tx ${r.hash}`);
console.log(`  https://testnet.nearblocks.io/txns/${r.hash}`);
console.log(`  ${contractId} balance ${toNear(after)} NEAR`);
