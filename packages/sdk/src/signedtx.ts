import { sha256 } from "@noble/hashes/sha2.js";
import { baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { SentinelInputError } from "./errors.js";

export interface DecodedSignedTx {
  hash: string;
  signerId: string;
  receiverId: string;
  publicKey: string;
  nonce: bigint;
  blockHash: string;
  actionCount: number;
}

/**
 * Decode a base64 borsh-encoded SignedTransaction (what wallets/near-api-js produce and what
 * `send_tx` accepts). Read-only: we never sign, and the signature is not needed.
 */
export function decodeSignedTx(base64: string): DecodedSignedTx {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  } catch {
    throw new SentinelInputError("signedTransactionBase64 is not valid base64");
  }
  if (bytes.length < 64 || bytes.length > 1_500_000) {
    throw new SentinelInputError("signedTransactionBase64 has an implausible length");
  }
  let st: any;
  try {
    st = decodeSignedTransaction(bytes);
  } catch (e: any) {
    throw new SentinelInputError(`Could not decode SignedTransaction: ${e?.message ?? e}`);
  }
  const tx = st.transaction;
  const hash = baseEncode(sha256(encodeTransaction(tx)));
  return {
    hash,
    signerId: tx.signerId,
    receiverId: tx.receiverId,
    publicKey: tx.publicKey.toString(),
    nonce: BigInt(tx.nonce),
    blockHash: baseEncode(Uint8Array.from(tx.blockHash as ArrayLike<number>)),
    actionCount: tx.actions.length,
  };
}
