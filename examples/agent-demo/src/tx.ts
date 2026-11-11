/**
 * Minimal transfer building/signing/sending for the demo AGENTS.
 * (The Sentinel product itself never signs or sends — only these demo agents do.)
 */
import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
  KeyPair,
  SignedTransaction,
  Signature,
  type KeyPairString,
} from "near-api-js";

export interface Signed {
  base64: string;
  hash: string;
  nonce: bigint;
}

export function signTransfer(opts: {
  keyPair: KeyPair;
  signerId: string;
  receiverId: string;
  nonce: bigint;
  amountYocto: bigint;
  blockHash: string;
}): Signed {
  const tx = createTransaction(
    opts.signerId,
    opts.keyPair.getPublicKey(),
    opts.receiverId,
    opts.nonce,
    [actions.transfer(opts.amountYocto)],
    baseDecode(opts.blockHash),
  );
  const h = sha256(encodeTransaction(tx));
  const sig = opts.keyPair.sign(h);
  const st = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
  return { base64: Buffer.from(st.encode()).toString("base64"), hash: baseEncode(h), nonce: opts.nonce };
}

export function keyPairFrom(secret: string): KeyPair {
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(secret)) throw new Error("Private key must look like ed25519:<base58>");
  return KeyPair.fromString(secret as KeyPairString);
}

export async function rpc(url: string, method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "demo", method, params }),
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export type SendOutcome = { kind: "ok"; result: any } | { kind: "rpc-error"; error: any } | { kind: "timeout" };

/** Submit with a client deadline — exactly what an agent's HTTP tool does. */
export async function sendTx(url: string, base64: string, timeoutMs: number): Promise<SendOutcome> {
  try {
    const j = await rpc(url, "send_tx", { signed_tx_base64: base64, wait_until: "EXECUTED_OPTIMISTIC" }, timeoutMs);
    return j.error ? { kind: "rpc-error", error: j.error } : { kind: "ok", result: j.result };
  } catch (e: any) {
    if (e?.name === "AbortError") return { kind: "timeout" };
    return { kind: "rpc-error", error: String(e?.message ?? e) };
  }
}

export async function accessKeyNonceAndBlock(url: string, accountId: string, publicKey: string): Promise<{ nonce: bigint; blockHash: string }> {
  const ak = await rpc(url, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  if (ak.error || ak.result?.error) throw new Error(`view_access_key failed: ${JSON.stringify(ak.error ?? ak.result.error)}`);
  return { nonce: BigInt(ak.result.nonce), blockHash: ak.result.block_hash };
}

export async function balanceYocto(url: string, accountId: string): Promise<bigint> {
  const a = await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  if (a.error || a.result?.error) throw new Error(`view_account failed for ${accountId}: ${JSON.stringify(a.error ?? a.result.error)}`);
  return BigInt(a.result.amount);
}

export const toNear = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(6);

/**
 * The sender's private key: DEMO_SENDER_PRIVATE_KEY, or — when that is empty and the sender is the Guard test
 * payer — GUARD_TEST_PAYER_PRIVATE_KEY from contracts/guard/.env, so the owner never copies keys between files.
 * Read from git-ignored .env files only; never printed.
 */
export function resolveSenderKey(sender: string, demoKey: string, guardEnvFile: string): { secret: string; source: string } {
  if (demoKey) return { secret: demoKey, source: "examples/agent-demo/.env" };
  if (!existsSync(guardEnvFile)) return { secret: "", source: "" };
  const env = Object.fromEntries(
    readFileSync(guardEnvFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  return env.GUARD_TEST_PAYER_ACCOUNT_ID === sender && env.GUARD_TEST_PAYER_PRIVATE_KEY
    ? { secret: env.GUARD_TEST_PAYER_PRIVATE_KEY, source: "contracts/guard/.env (same payer account)" }
    : { secret: "", source: "" };
}
