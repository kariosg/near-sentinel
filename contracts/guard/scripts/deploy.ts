/**
 * Deploy the Sentinel Guard to TESTNET from YOUR contract account.
 * Keys are read only from contracts/guard/.env (git-ignored) and never printed.
 *
 *   pnpm --filter @near-sentinel/guard deploy                 # dry run: shows exactly what would happen
 *   pnpm --filter @near-sentinel/guard deploy -- --i-confirm  # deploys + calls new()
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, balance, codeHash, keyPairFrom, loadEnvFile, readWasm, rpc, signAndSend, TGAS, toNear, view, wasmSha256Base58 } from "./near.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(here, "..", ".env"));
const CONFIRM = process.argv.includes("--i-confirm");
const url = process.env.GUARD_RPC_URL ?? "https://test.rpc.fastnear.com";
const contractId = process.env.GUARD_CONTRACT_ID ?? "";
const payerId = process.env.GUARD_TEST_PAYER_ACCOUNT_ID ?? "";
// A sub-account created by create-contract-account.ts shares the payer's key, so nobody has to copy keys around.
const sharesPayerKey = !process.env.GUARD_CONTRACT_PRIVATE_KEY && !!payerId && contractId.endsWith(`.${payerId}`);
const secret = (sharesPayerKey ? process.env.GUARD_TEST_PAYER_PRIVATE_KEY : process.env.GUARD_CONTRACT_PRIVATE_KEY) ?? "";
if (sharesPayerKey) console.log(`using the payer key (${contractId} is a sub-account of ${payerId} and shares it)`);
const wasmPath = process.env.GUARD_WASM ?? join(here, "..", "target-docker", "wasm32-unknown-unknown", "release", "sentinel_guard.wasm");
const EMPTY_CODE = "11111111111111111111111111111111";

const fail = (m: string): never => {
  console.error(`✕ ${m}`);
  process.exit(1);
};

if (!contractId || !secret) fail("Fill GUARD_CONTRACT_ID and GUARD_CONTRACT_PRIVATE_KEY in contracts/guard/.env (template: .env.example).");
if (!contractId.endsWith(".testnet")) fail(`GUARD_CONTRACT_ID must be a .testnet account (got ${contractId}).`);
const status = await rpc(url, "status", []).catch((e) => fail(`Could not reach ${url}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing: ${url} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);

const keyPair = keyPairFrom(secret, "GUARD_CONTRACT_PRIVATE_KEY");
const pk = keyPair.getPublicKey().toString();
const ak = await rpc(url, "query", { request_type: "view_access_key", finality: "final", account_id: contractId, public_key: pk });
if (ak.error || ak.result?.error) fail(`The key in .env is not an access key of ${contractId} on testnet.`);
if (ak.result.permission !== "FullAccess") fail("Deploying needs a FullAccess key of the contract account.");

const wasm = readWasm(wasmPath);
const wasmHash = wasmSha256Base58(wasm);
const current = await codeHash(url, contractId);
const bal = await balance(url, contractId);

console.log("━━ Sentinel Guard — TESTNET deploy ━━");
console.log(`network      : testnet (verified via ${url} status.chain_id)`);
console.log(`account      : ${contractId}  (key ${pk.slice(0, 16)}…, FullAccess)  balance ${toNear(bal)} NEAR`);
console.log(`wasm         : ${wasmPath}`);
console.log(`wasm size    : ${wasm.length} bytes, code_hash ${wasmHash}`);
console.log(`current code : ${current === EMPTY_CODE ? "none" : current}`);
console.log("actions      : DeployContract(wasm) + FunctionCall new() — no deposit; the contract has no owner or admin methods");

if (current === wasmHash) {
  const v = await view(url, contractId, "version", {}).catch(() => undefined);
  console.log(`\nAlready deployed (identical code, version ${v ?? "not initialized"}). Nothing to do.`);
  process.exit(0);
}
if (current !== EMPTY_CODE) fail("The account already has different contract code. Use a fresh account so existing state can't clash.");
if (bal < 2n * 10n ** 24n) fail(`Balance ${toNear(bal)} NEAR is too low; keep ≥ 2 NEAR for code storage (~${(wasm.length / 100_000).toFixed(2)} NEAR) and intents.`);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm to deploy.");
  process.exit(0);
}

const r = await signAndSend(url, { accountId: contractId, keyPair }, contractId, [actions.deployContract(wasm), actions.functionCall("new", {}, 30n * TGAS, 0n)]);
if (!r.ok) fail(`Deploy failed (tx ${r.hash}): ${r.failure}`);
const after = await codeHash(url, contractId);
const version = await view(url, contractId, "version", {});
console.log(`\n✓ deployed — tx ${r.hash}`);
console.log(`  https://testnet.nearblocks.io/txns/${r.hash}`);
console.log(`  on-chain code_hash ${after} ${after === wasmHash ? "(matches local wasm)" : "(MISMATCH!)"}; version ${version}`);
process.exit(after === wasmHash ? 0 : 1);
