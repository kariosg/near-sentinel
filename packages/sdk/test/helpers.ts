import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { KeyPair, SignedTransaction, Signature, actions, baseDecode, baseEncode, createTransaction, encodeTransaction } from "near-api-js";
import type { RawTxStatusResult } from "../src/outcome.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): RawTxStatusResult {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
}

/**
 * Build a signed transaction purely in memory for decode/retry tests.
 * The key is random, lives only for the test run, and the tx is never broadcast.
 */
export function makeSignedTx(opts: {
  signerId?: string;
  receiverId?: string;
  nonce?: bigint;
  blockHash?: string;
} = {}): { base64: string; hash: string; publicKey: string; nonce: bigint; blockHash: string; signerId: string } {
  const kp = KeyPair.fromRandom("ed25519");
  const blockHash = opts.blockHash ?? "6PgMk66qqRgo2TsmXFnvL6kwn5FS2Z9DDqMoaYXfwXTZ";
  const nonce = opts.nonce ?? 42n;
  const signerId = opts.signerId ?? "alice.testnet";
  const tx = createTransaction(signerId, kp.getPublicKey(), opts.receiverId ?? "bob.testnet", nonce, [actions.transfer(1n)], baseDecode(blockHash));
  const h = sha256(encodeTransaction(tx));
  const sig = kp.sign(h);
  const st = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
  return {
    base64: Buffer.from(st.encode()).toString("base64"),
    hash: baseEncode(h),
    publicKey: kp.getPublicKey().toString(),
    nonce,
    blockHash,
    signerId,
  };
}
