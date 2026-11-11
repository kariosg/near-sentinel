/**
 * Sentinel Vault on TESTNET, end to end, using ONLY the existing payer key from contracts/guard/.env
 * (no key is generated). Dry run by default; `--i-confirm` sends.
 *
 *   1. Create VAULT_CONTRACT_ID (default vault.<payer>) as a sub-account of the payer, with the payer's existing key.
 *   2. Deploy the vault wasm and call new(); verify the on-chain code hash.
 *   3. Run the vault suite with owner = agent = the payer (full-access key). The function-call-key checks run
 *      in the local sandbox suite, where throwaway keys are allowed.
 *   4. Leave a small demo policy: owner = payer, agent = GUARD_TEST_RECEIVER_ACCOUNT_ID (read by the dashboard).
 *
 *   pnpm --filter @near-sentinel/guard vault:testnet                 # dry run
 *   pnpm --filter @near-sentinel/guard vault:testnet -- --i-confirm  # send
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountExists, actions, balance, codeHash, keyPairFrom, loadEnvFile, NEAR, readWasm, rpc, signAndSend, TGAS, toNear, view, wasmSha256Base58 } from "./near.js";
import { summarize } from "./suite.js";
import { runVaultSuite } from "./vault-suite.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(here, "..", ".env"));
const CONFIRM = process.argv.includes("--i-confirm");
// --upgrade: deploy new code over an existing vault WITHOUT calling new() (the state layout is unchanged, so policies survive).
const UPGRADE = process.argv.includes("--upgrade");
const url = process.env.GUARD_RPC_URL ?? "https://test.rpc.fastnear.com";
const payerId = process.env.GUARD_TEST_PAYER_ACCOUNT_ID ?? "";
const payerKey = process.env.GUARD_TEST_PAYER_PRIVATE_KEY ?? "";
const receiverId = process.env.GUARD_TEST_RECEIVER_ACCOUNT_ID ?? "";
const vaultId = process.env.VAULT_CONTRACT_ID || `vault.${payerId}`;
const wasmPath = join(here, "..", "target-docker", "wasm32-unknown-unknown", "release", "sentinel_vault.wasm");
const FUND = 3n * NEAR; // contract account: ~2 NEAR code storage + headroom
const UNIT = NEAR / 100n; // suite amounts: 1 unit = 0.01 NEAR
const DEMO_DEPOSIT = NEAR / 5n; // demo allowance left for the dashboard example (withdrawable by the owner)

const fail = (m: string): never => {
  console.error(`✕ ${m}`);
  process.exit(1);
};
if (!payerId || !payerKey || !receiverId) fail("Fill GUARD_TEST_PAYER_ACCOUNT_ID, GUARD_TEST_PAYER_PRIVATE_KEY and GUARD_TEST_RECEIVER_ACCOUNT_ID in contracts/guard/.env.");
if (!vaultId.endsWith(`.${payerId}`)) fail(`${vaultId} must be a sub-account of ${payerId}.`);
const status = await rpc(url, "status", []).catch((e) => fail(`Could not reach ${url}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing: ${url} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);

const payer = { accountId: payerId, keyPair: keyPairFrom(payerKey, "GUARD_TEST_PAYER_PRIVATE_KEY") };
const pk = payer.keyPair.getPublicKey();
const wasm = readWasm(wasmPath);
const exists = await accountExists(url, vaultId);
const current = exists ? await codeHash(url, vaultId) : "none";
const wasmHash = wasmSha256Base58(wasm);
const payerBal = await balance(url, payerId);

console.log("━━ Sentinel Vault — TESTNET ━━");
console.log(`network     : testnet (verified via ${url} status.chain_id)`);
console.log(`payer/owner : ${payerId}  balance ${toNear(payerBal)} NEAR (key ${pk.toString().slice(0, 16)}…, from .env, not shown)`);
console.log(`vault       : ${vaultId}  ${exists ? `exists, code ${current}` : `will be created with ${toNear(FUND)} NEAR and the payer's EXISTING key`}`);
console.log(`wasm        : ${wasm.length} bytes, code_hash ${wasmHash}${current === wasmHash ? " (already deployed)" : exists && current !== "11111111111111111111111111111111" ? (UPGRADE ? " (UPGRADE: code only, state kept)" : " (differs from the deployed code; pass --upgrade to replace it)") : ""}`);
console.log(`agent       : a fresh sub-account a<run>.${payerId} per run (0.1 NEAR for prepaid gas, returned at the end; the payer's existing key)`);
console.log(`suite       : ~12 transactions; amounts in units of ${toNear(UNIT)} NEAR; at most ${toNear(14n * UNIT / 10n)} NEAR reaches ${receiverId}; the rest is withdrawn back`);
console.log(`demo policy : owner ${payerId} → agent ${receiverId}: ${toNear(DEMO_DEPOSIT)} NEAR (per payment 0.05, per day 0.1, only to ${payerId}); withdrawable by the owner`);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm.");
  process.exit(0);
}
if (payerBal < FUND + 2n * NEAR) fail(`Payer balance too low; keep ≥ ${toNear(FUND + 2n * NEAR)} NEAR.`);

if (!exists) {
  const c = await signAndSend(url, payer, vaultId, [actions.createAccount(), actions.transfer(FUND), actions.addFullAccessKey(pk)]);
  if (!c.ok) fail(`create ${vaultId} failed: ${c.failure}`);
  console.log(`✓ created ${vaultId} — https://testnet.nearblocks.io/txns/${c.hash}`);
}
if (current !== wasmHash) {
  const hasCode = current !== "none" && current !== "11111111111111111111111111111111";
  if (hasCode && !UPGRADE) fail(`${vaultId} already has different code; pass --upgrade to replace it (state is kept).`);
  const d = await signAndSend(
    url,
    { accountId: vaultId, keyPair: payer.keyPair },
    vaultId,
    hasCode ? [actions.deployContract(wasm)] : [actions.deployContract(wasm), actions.functionCall("new", {}, 30n * TGAS, 0n)],
  );
  if (!d.ok) fail(`deploy failed: ${d.failure}`);
  const after = await codeHash(url, vaultId);
  console.log(`✓ deployed — https://testnet.nearblocks.io/txns/${d.hash}\n  on-chain code_hash ${after} ${after === wasmHash ? "(matches local wasm)" : "(MISMATCH!)"}; version ${await view(url, vaultId, "version", {})}`);
  if (after !== wasmHash) process.exit(1);
}

const runId = `t${Date.now().toString(36)}`;
// A fresh agent account per run (sub-account of the payer, with the payer's EXISTING key and 0.1 NEAR for prepaid gas),
// so each run starts with an untouched 24-hour window. No key is generated.
const agentId = `a${runId}.${payerId}`;
const mk = await signAndSend(url, payer, agentId, [actions.createAccount(), actions.transfer(NEAR / 10n), actions.addFullAccessKey(pk)]);
if (!mk.ok) fail(`create agent ${agentId}: ${mk.failure}`);
console.log(`✓ fresh agent ${agentId} — https://testnet.nearblocks.io/txns/${mk.hash}`);
const results = await runVaultSuite({
  rpcUrl: url,
  vaultId,
  owner: payer,
  agentFc: { accountId: agentId, keyPair: payer.keyPair }, // full-access key on testnet: the restricted-key checks are skipped below
  skipRestrictedKeyChecks: true,
  shopId: receiverId,
  missingId: `sentinel-nobody-${runId}.testnet`,
  outsiderId: vaultId.replace(/^vault\./, "outsider."),
  runId,
  unit: UNIT,
  explorer: (h) => `https://testnet.nearblocks.io/txns/${h}`,
});

// Return the agent's unused gas money to the payer (keeps 0.003 NEAR for the account's own storage).
await new Promise((r) => setTimeout(r, 3000));
const left = await balance(url, agentId);
const back = left - (3n * NEAR) / 1000n - NEAR / 1000n; // minus storage and this transfer's fee
if (back > 0n) {
  const ret = await signAndSend(url, { accountId: agentId, keyPair: payer.keyPair }, payerId, [actions.transfer(back)]);
  console.log(`${ret.ok ? "✓" : "✕"} returned ${toNear(back)} NEAR from ${agentId} to ${payerId}`);
}

// Demo policy for the dashboard's "Live agent allowance" example (created once; an upgrade keeps it).
const existingDemo = await view(url, vaultId, "get_policy", { owner_id: payerId, agent_id: receiverId });
const demo = existingDemo ? { ok: true, hash: "(kept existing demo policy)" } : await signAndSend(url, payer, vaultId, [
  actions.functionCall("set_policy", { agent_id: receiverId, per_payment_max: String(NEAR / 20n), daily_max: String(NEAR / 10n), allowed_receivers: [payerId] }, 60n * TGAS, DEMO_DEPOSIT),
]);
console.log(`${demo.ok ? "✓" : "✕"} demo policy ${payerId} → ${receiverId}: ${existingDemo ? "kept (" + existingDemo.balance + " yocto)" : `https://testnet.nearblocks.io/txns/${demo.hash}`}`);
process.exit(summarize(results) && demo.ok ? 0 : 1);
