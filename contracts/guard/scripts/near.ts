/**
 * Minimal signing helpers for the guard's deploy and integration scripts.
 * Keys come ONLY from environment variables (loaded from a git-ignored .env) and are never printed.
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
  type Action,
  type KeyPairString,
} from "near-api-js";

export { actions };

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const toNear = (y: bigint) => {
  const neg = y < 0n;
  const a = neg ? -y : y;
  return `${neg ? "-" : ""}${a / NEAR}.${(a % NEAR).toString().padStart(24, "0").slice(0, 6)}`;
};

export function loadEnvFile(path: string) {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function keyPairFrom(secret: string, label: string): KeyPair {
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,}$/.test(secret)) throw new Error(`${label} must look like ed25519:<base58 secret key> (value not shown)`);
  return KeyPair.fromString(secret as KeyPairString);
}

export interface Signer {
  accountId: string;
  keyPair: KeyPair;
}

export async function rpc(url: string, method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "guard", method, params }),
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function view(url: string, contractId: string, method: string, args: object): Promise<any> {
  const r = await rpc(url, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error || r.result?.error) throw new Error(`view ${method} failed: ${JSON.stringify(r.error ?? r.result.error)}`);
  return JSON.parse(Buffer.from(r.result.result).toString());
}

export async function balance(url: string, accountId: string): Promise<bigint> {
  const a = await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  if (a.error || a.result?.error) throw new Error(`view_account ${accountId}: ${JSON.stringify(a.error ?? a.result.error)}`);
  return BigInt(a.result.amount);
}

export async function accountExists(url: string, accountId: string): Promise<boolean> {
  const a = await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  return !a.error && !a.result?.error;
}

export async function codeHash(url: string, accountId: string): Promise<string> {
  const a = await rpc(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  if (a.error || a.result?.error) throw new Error(`view_account ${accountId}: ${JSON.stringify(a.error ?? a.result.error)}`);
  return a.result.code_hash as string;
}

export interface TxOutcome {
  hash: string;
  ok: boolean;
  /** Flattened failure text from the tx status and every receipt (empty when ok). */
  failure: string;
  /** Every receipt failure, including the ones that don't fail the tx (e.g. a failed transfer inside a callback flow). */
  receiptFailures: string[];
  logs: string[];
  raw: any;
}

/** Build, sign and submit one transaction; waits for FINAL. */
export async function signAndSend(url: string, signer: Signer, receiverId: string, acts: Action[], waitUntil = "FINAL", nonceOffset = 1n): Promise<TxOutcome> {
  const pk = signer.keyPair.getPublicKey();
  const ak = await rpc(url, "query", { request_type: "view_access_key", finality: "final", account_id: signer.accountId, public_key: pk.toString() });
  if (ak.error || ak.result?.error) throw new Error(`Key is not an access key of ${signer.accountId}: ${JSON.stringify(ak.error ?? ak.result.error)}`);
  const tx = createTransaction(signer.accountId, pk, receiverId, BigInt(ak.result.nonce) + nonceOffset, acts, baseDecode(ak.result.block_hash));
  const h = sha256(encodeTransaction(tx));
  const sig = signer.keyPair.sign(h);
  const st = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
  const hash = baseEncode(h);
  const r = await rpc(url, "send_tx", { signed_tx_base64: Buffer.from(st.encode()).toString("base64"), wait_until: waitUntil }, 120_000);
  if (r.error) return { hash, ok: false, failure: JSON.stringify(r.error), receiptFailures: [], logs: [], raw: r };
  return toOutcome(hash, r.result);
}

/** Wait for a broadcast transaction to become FINAL and return its outcome. */
export async function awaitFinal(url: string, hash: string, senderId: string): Promise<TxOutcome> {
  for (let i = 0; i < 60; i++) {
    const r = await rpc(url, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: senderId, wait_until: "FINAL" }, 30_000).catch(() => undefined);
    if (r?.result?.final_execution_status === "FINAL") return toOutcome(hash, r.result);
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { hash, ok: false, failure: "not final after 60 attempts", receiptFailures: [], logs: [], raw: null };
}

function toOutcome(hash: string, res: any): TxOutcome {
  const receiptFailures = (res.receipts_outcome ?? [])
    .filter((o: any) => o.outcome?.status?.Failure)
    .map((o: any) => JSON.stringify(o.outcome.status.Failure));
  const logs = (res.receipts_outcome ?? []).flatMap((o: any) => o.outcome?.logs ?? []);
  const top = res.status?.Failure ? JSON.stringify(res.status.Failure) : "";
  return { hash, ok: !res.status?.Failure, failure: top, receiptFailures, logs, raw: res };
}

export function readWasm(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`Wasm not found at ${path}. Build it first (see contracts/guard/README.md).`);
  return new Uint8Array(readFileSync(path));
}

export function wasmSha256Base58(wasm: Uint8Array): string {
  return baseEncode(sha256(wasm));
}
