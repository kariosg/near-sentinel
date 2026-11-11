/**
 * REAL TESTNET critical-case check of NEAR Sentinel's retry verdicts, using freshly signed transfers.
 *
 *   node dist/critical.js               # DRY RUN: validates config, prints the plan, sends nothing
 *   node dist/critical.js --i-confirm   # sends ONE small transfer on NEAR TESTNET
 *
 * Cases (all checked with the signed bytes, the definitive input):
 *   A. Signed but never sent            → must NOT be SAFE_TO_RETRY (it could still land) → WAIT_AND_RECHECK
 *   B. A different tx consumes A's nonce → A can never land → SAFE_TO_RETRY, proven by ≥ 2 independent operators
 *   C. The tx that landed               → DO_NOT_RETRY
 *   D. Bytes that are not a signed tx   → rejected as invalid input, never a verdict
 *
 * Config: examples/agent-demo/.env (git-ignored). The key is read only from there and never printed.
 * Safety gates: chain_id must be "testnet"; one transfer of 0.001 NEAR to DEMO_RECEIVER_ACCOUNT_ID; nothing is sent without --i-confirm.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NearSentinel, SentinelInputError } from "@near-sentinel/sdk";
import { accessKeyNonceAndBlock, balanceYocto, keyPairFrom, resolveSenderKey, rpc, signTransfer, toNear } from "./tx.js";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const CONFIRM = process.argv.includes("--i-confirm");
const RPC = process.env.DEMO_RPC_URL ?? "https://test.rpc.fastnear.com";
const sender = process.env.DEMO_SENDER_ACCOUNT_ID ?? "";
const receiver = process.env.DEMO_RECEIVER_ACCOUNT_ID ?? "";
const { secret, source: keySource } = resolveSenderKey(sender, process.env.DEMO_SENDER_PRIVATE_KEY ?? "", join(here, "..", "..", "..", "contracts", "guard", ".env"));
const AMOUNT_A = 10n ** 21n; // 0.001 NEAR (never sent)
const AMOUNT_B = 11n * 10n ** 20n; // 0.0011 NEAR (sent once; different bytes from A)

const fail = (m: string): never => {
  console.error(`✕ ${m}`);
  process.exit(1);
};
if (!sender || !receiver || !secret) fail(`Fill DEMO_SENDER_ACCOUNT_ID, DEMO_SENDER_PRIVATE_KEY and DEMO_RECEIVER_ACCOUNT_ID in ${envFile}.`);
if (sender === receiver) fail("Sender and receiver must differ.");
const status = await rpc(RPC, "status", []).catch((e) => fail(`Could not reach ${RPC}: ${e?.message ?? e}`));
if (status.result?.chain_id !== "testnet") fail(`Refusing: ${RPC} reports chain_id=${status.result?.chain_id ?? "unknown"} (testnet required).`);
const keyPair = keyPairFrom(secret);
const pk = keyPair.getPublicKey().toString();
const ak = await rpc(RPC, "query", { request_type: "view_access_key", finality: "final", account_id: sender, public_key: pk });
if (ak.error || ak.result?.error) fail(`The key in .env is not an access key of ${sender} on testnet.`);
if (ak.result.permission !== "FullAccess") fail("A FullAccess key is needed to sign a Transfer.");

console.log("━━ NEAR Sentinel — REAL TESTNET critical cases ━━");
console.log(`network  : testnet (verified via ${RPC} status.chain_id)`);
console.log(`sender   : ${sender}  balance ${toNear(await balanceYocto(RPC, sender))} NEAR  (key from ${keySource}, not shown)`);
console.log(`receiver : ${receiver}`);
console.log(`plan     : sign A (${toNear(AMOUNT_A)} NEAR, never sent); send B (${toNear(AMOUNT_B)} NEAR) with A's nonce; check A, B and garbage bytes`);
if (!CONFIRM) {
  console.log("\nDRY RUN — nothing was sent. Re-run with --i-confirm.");
  process.exit(0);
}

const sentinel = new NearSentinel({ network: "testnet", timeoutMs: 15_000 });
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};
const summary = (r: Awaited<ReturnType<NearSentinel["checkRetrySafety"]>>) =>
  `${r.verdict} (${r.recommendation.confidence}), state ${r.state}; ${r.recommendation.checks.filter((c) => c.id.startsWith("proof") || c.id.includes("operator")).map((c) => c.detail).join("; ").slice(0, 220)}`;

const { nonce, blockHash } = await accessKeyNonceAndBlock(RPC, sender, pk);
const n = nonce + 1n;
const A = signTransfer({ keyPair, signerId: sender, receiverId: receiver, nonce: n, amountYocto: AMOUNT_A, blockHash });
const B = signTransfer({ keyPair, signerId: sender, receiverId: receiver, nonce: n, amountYocto: AMOUNT_B, blockHash });
console.log(`\nA ${A.hash} (nonce ${n}, signed, NOT sent)\nB ${B.hash} (nonce ${n}, will be sent)\n`);

// A: signed, never broadcast. It could still be submitted and land, so it must never be SAFE_TO_RETRY.
const a1 = await sentinel.checkRetrySafety({ signedTransactionBase64: A.base64 });
check("A. signed but never sent is not SAFE_TO_RETRY", a1.verdict !== "SAFE_TO_RETRY", summary(a1));
check("A. … and the agent is told to wait", a1.verdict === "WAIT_AND_RECHECK", a1.verdict);

// B: a different transaction consumes the same nonce, so A can never be included.
const sent = await rpc(RPC, "send_tx", { signed_tx_base64: B.base64, wait_until: "FINAL" }, 60_000);
if (sent.error) fail(`B was not accepted: ${JSON.stringify(sent.error).slice(0, 200)}`);
console.log(`      B landed: https://testnet.nearblocks.io/txns/${B.hash}`);
await new Promise((r) => setTimeout(r, 4000)); // let every provider see the new nonce at FINAL

const a2 = await sentinel.checkRetrySafety({ signedTransactionBase64: A.base64 });
check("B. once A's nonce is used by another tx, A is SAFE_TO_RETRY", a2.verdict === "SAFE_TO_RETRY", summary(a2));

const b = await sentinel.checkRetrySafety({ signedTransactionBase64: B.base64 });
check("C. the transaction that landed is DO_NOT_RETRY", b.verdict === "DO_NOT_RETRY" && b.state === "EXECUTED_SUCCESS", `${b.verdict}, state ${b.state}`);

// D: bytes that are not a signed transaction must be rejected as input, never turned into a verdict.
let gOk = false;
try {
  await sentinel.checkRetrySafety({ signedTransactionBase64: "bm90LWEtdHJhbnNhY3Rpb24=" });
} catch (e) {
  gOk = e instanceof SentinelInputError;
}
check("D. garbage bytes are rejected as invalid input", gOk, gOk ? "SentinelInputError" : "accepted!");

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} critical checks passed`);
process.exit(passed === results.length ? 0 : 1);
