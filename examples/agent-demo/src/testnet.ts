/**
 * REAL TESTNET demo: naive vs Sentinel-guarded agent after a timeout that hides a delivered transfer.
 *
 *   node dist/testnet.js               # DRY RUN: validates config, prints the exact plan, sends nothing
 *   node dist/testnet.js --i-confirm   # executes the plan on NEAR TESTNET
 *
 * Configuration: examples/agent-demo/.env (git-ignored; see .env.example). The private key is read
 * from that file only, is used only to sign the demo transfers, and is never printed or logged.
 *
 * Safety gates: chain_id must be "testnet"; amount ≤ 0.1 NEAR; sender ≠ receiver; balance checked;
 * nothing is sent without --i-confirm.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NearSentinel } from "@near-sentinel/sdk";
import { startFaultProxy } from "@near-sentinel/sdk/testing";
import { guardedAgent, naiveAgent, type AgentEnv } from "./agents.js";
import { balanceYocto, keyPairFrom, resolveSenderKey, rpc, toNear } from "./tx.js";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const CONFIRM = process.argv.includes("--i-confirm");
const RPC = process.env.DEMO_RPC_URL ?? "https://test.rpc.fastnear.com";
const sender = process.env.DEMO_SENDER_ACCOUNT_ID ?? "";
const receiver = process.env.DEMO_RECEIVER_ACCOUNT_ID ?? "";
const { secret, source: keySource } = resolveSenderKey(sender, process.env.DEMO_SENDER_PRIVATE_KEY ?? "", join(here, "..", "..", "..", "contracts", "guard", ".env"));
const amountNear = Number(process.env.DEMO_AMOUNT_NEAR ?? "0.01");

function fail(msg: string): never {
  console.error(`✕ ${msg}`);
  process.exit(1);
}

if (!sender || !receiver || !secret) fail(`Missing config. Copy .env.example to ${envFile} and fill DEMO_SENDER_ACCOUNT_ID, DEMO_SENDER_PRIVATE_KEY, DEMO_RECEIVER_ACCOUNT_ID.`);
if (sender === receiver) fail("Sender and receiver must be different accounts.");
if (!(amountNear > 0 && amountNear <= 0.1)) fail("DEMO_AMOUNT_NEAR must be > 0 and ≤ 0.1.");
const amountYocto = BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n;

const status = await rpc(RPC, "status", []).catch((e) => fail(`Could not reach ${RPC}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing to run: ${RPC} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);

const keyPair = keyPairFrom(secret);
const pk = keyPair.getPublicKey().toString();
const ak = await rpc(RPC, "query", { request_type: "view_access_key", finality: "final", account_id: sender, public_key: pk });
if (ak.error || ak.result?.error) fail(`The key in .env is not an access key of ${sender} on testnet (${JSON.stringify(ak.error ?? ak.result.error)}).`);
if (ak.result.permission !== "FullAccess") fail("The demo needs a FullAccess key (it sends Transfer actions).");

const senderBefore = await balanceYocto(RPC, sender);
const receiverBefore = await balanceYocto(RPC, receiver);
// Worst case signed: naive 2 + guarded 2 (guarded signs again only on SAFE_TO_RETRY).
const maxSpend = amountYocto * 4n;
const reserve = 5n * 10n ** 22n; // 0.05 NEAR for fees and storage
if (senderBefore < maxSpend + reserve) fail(`Sender balance ${toNear(senderBefore)} NEAR is too low; need at least ${toNear(maxSpend + reserve)} NEAR.`);

console.log("━━ NEAR Sentinel — REAL TESTNET demo ━━");
console.log(`network        : testnet (verified via ${RPC} status.chain_id)`);
console.log(`sender         : ${sender}  (key ${pk.slice(0, 16)}… from ${keySource}, FullAccess)  balance ${toNear(senderBefore)} NEAR`);
console.log(`receiver       : ${receiver}  balance ${toNear(receiverBefore)} NEAR`);
console.log(`amount per tx  : ${amountNear} NEAR`);
console.log("plan           : naive agent sends 1 intended payment (expected to execute TWICE),");
console.log("                 guarded agent sends 1 intended payment (expected to execute ONCE).");
console.log(`max spend      : ${toNear(maxSpend)} NEAR + fees`);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm to execute this plan.");
  process.exit(0);
}

const proxy = await startFaultProxy(RPC);
proxy.setFault("send_tx", { type: "forward-then-hang" }); // delivered to the chain, but the agent never hears back
const lines: string[] = [];
const log = (l: string) => {
  lines.push(l);
  console.log(l);
};
const env: AgentEnv = { sendUrl: proxy.url, directUrl: RPC, signerId: sender, receiverId: receiver, keyPair, amountYocto, timeoutMs: 4000, log };
const sentinel = new NearSentinel({ network: "testnet", timeoutMs: 15_000 });

try {
  console.log("\n── Naive agent ──");
  const naive = await naiveAgent(env);
  await new Promise((r) => setTimeout(r, 6000)); // let both transfers finalise
  const mid = await balanceYocto(RPC, receiver);
  console.log("\n── Guarded agent (NEAR Sentinel) ──");
  const guarded = await guardedAgent(env, sentinel);
  await new Promise((r) => setTimeout(r, 6000));
  const after = await balanceYocto(RPC, receiver);

  const naiveDelta = mid - receiverBefore;
  const guardedDelta = after - mid;
  console.log("\n━━ Result ━━");
  console.log(`naive   : intended ${amountNear} NEAR → receiver got ${toNear(naiveDelta)} NEAR (${Number(naiveDelta / amountYocto)}×)`);
  console.log(`guarded : intended ${amountNear} NEAR → receiver got ${toNear(guardedDelta)} NEAR (${Number(guardedDelta / amountYocto)}×)`);
  console.log("\nTransactions (NearBlocks):");
  for (const s of [...naive.signed.map((x) => ["naive", x] as const), ...guarded.signed.map((x) => ["guarded", x] as const)]) {
    console.log(`  ${s[0].padEnd(8)} https://testnet.nearblocks.io/txns/${s[1].hash}`);
  }
} finally {
  await proxy.close();
}
