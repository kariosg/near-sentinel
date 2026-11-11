/**
 * Full on-chain test of the guard on a LOCAL, throwaway NEAR sandbox (neard, chain id "sandbox").
 * No real funds. The root key of the sandbox's genesis account comes from SANDBOX_ROOT_KEY (set by
 * the runner script from the container), and every other key is generated in memory for this run only.
 *
 *   SANDBOX_RPC_URL=http://127.0.0.1:3031 SANDBOX_ROOT_KEY=... node dist/sandbox.js
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { actions, codeHash, keyPairFrom, NEAR, readWasm, rpc, signAndSend, TGAS, wasmSha256Base58, type Signer } from "./near.js";
import { near, runSuite, summarize } from "./suite.js";
import { runVaultSuite } from "./vault-suite.js";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.SANDBOX_RPC_URL ?? "http://127.0.0.1:3031";
const rootKey = process.env.SANDBOX_ROOT_KEY ?? "";
const wasmPath = process.env.GUARD_WASM ?? join(here, "..", "target-docker", "wasm32-unknown-unknown", "release", "sentinel_guard.wasm");
const vaultWasmPath = process.env.VAULT_WASM ?? join(here, "..", "target-docker", "wasm32-unknown-unknown", "release", "sentinel_vault.wasm");

const status = await rpc(url, "status", []);
if (status.result?.chain_id !== "sandbox") {
  console.error(`✕ Refusing: ${url} reports chain_id=${status.result?.chain_id ?? "unreachable"} (this script only runs on a local sandbox).`);
  process.exit(1);
}
const root: Signer = { accountId: "test.near", keyPair: keyPairFrom(rootKey, "SANDBOX_ROOT_KEY") };

async function createAccount(name: string, amountNear: bigint): Promise<Signer> {
  const kp = KeyPair.fromRandom("ed25519"); // sandbox-only, in memory, discarded after the run
  const accountId = `${name}.test.near`;
  const r = await signAndSend(url, root, accountId, [
    actions.createAccount(),
    actions.transfer(amountNear * NEAR),
    actions.addFullAccessKey(kp.getPublicKey()),
  ]);
  if (!r.ok) throw new Error(`create ${accountId}: ${r.failure}`);
  return { accountId, keyPair: kp };
}

const runId = `r${Date.now().toString(36)}`;
console.log(`━━ Sentinel Guard — local sandbox (${url}, neard ${status.result.version?.version}, protocol ${status.result.protocol_version}) ━━`);
const guard = await createAccount(`guard-${runId}`, 10n);
const payer = await createAccount(`payer-${runId}`, 20n);
const payer2 = await createAccount(`payer2-${runId}`, 20n);
const merchant = await createAccount(`merchant-${runId}`, 1n);

const wasm = readWasm(wasmPath);
const d = await signAndSend(url, guard, guard.accountId, [actions.deployContract(wasm), actions.functionCall("new", {}, 30n * TGAS, 0n)]);
const hashOnChain = await codeHash(url, guard.accountId);
console.log(`${d.ok && hashOnChain === wasmSha256Base58(wasm) ? "PASS" : "FAIL"}  deploy + init — code_hash ${hashOnChain} (local wasm ${wasmSha256Base58(wasm)}, ${wasm.length} bytes)`);
if (!d.ok) {
  console.error(d.failure);
  process.exit(1);
}

const results = await runSuite({
  rpcUrl: url,
  contractId: guard.accountId,
  payer,
  payer2,
  receiverId: merchant.accountId,
  missingReceiverId: `nobody-${runId}.test.near`,
  amount: near(1),
  largeFailAmount: near(15),
  runId,
});

// ── Sentinel Vault: an agent with a function-call key, spending within an owner's policy ──
console.log(`
━━ Sentinel Vault — same sandbox ━━`);
const vault = await createAccount(`vault-${runId}`, 10n);
const owner = await createAccount(`owner-${runId}`, 20n);
const agent = await createAccount(`agent-${runId}`, 2n);
const shop = await createAccount(`shop-${runId}`, 1n);
const vwasm = readWasm(vaultWasmPath);
const vd = await signAndSend(url, vault, vault.accountId, [actions.deployContract(vwasm), actions.functionCall("new", {}, 30n * TGAS, 0n)]);
const vHash = await codeHash(url, vault.accountId);
const deployOk = vd.ok && vHash === wasmSha256Base58(vwasm);
console.log(`${deployOk ? "PASS" : "FAIL"}  vault: deploy + init — code_hash ${vHash} (${vwasm.length} bytes)`);
const vaultResults = deployOk
  ? await runVaultSuite({
      rpcUrl: url,
      vaultId: vault.accountId,
      owner,
      agentFull: agent,
      shopId: shop.accountId,
      missingId: `nobody-v-${runId}.test.near`,
      outsiderId: payer2.accountId,
      intruder: payer2,
      runId,
      unit: NEAR,
    })
  : [{ name: "vault: deploy", pass: false, detail: vd.failure }];
process.exit(summarize([...results, ...vaultResults]) ? 0 : 1);
