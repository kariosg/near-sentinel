import { baseDecode } from "near-api-js";
import { z } from "zod";
import { SentinelInputError } from "./errors.js";

/** NEAR account ID rules (nep-0001): 2–64 chars, lowercase alnum separated by - _ . */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(s: string): boolean {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
}

/** A base58 string that decodes to exactly 32 bytes (tx hash, receipt id, block hash). */
export function isValidCryptoHash(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  try {
    return baseDecode(s).length === 32;
  } catch {
    return false;
  }
}

export const accountIdSchema = z.string().refine(isValidAccountId, "Invalid NEAR account ID");
export const cryptoHashSchema = z.string().refine(isValidCryptoHash, "Must be a base58-encoded 32-byte hash");
export const publicKeySchema = z.string().regex(/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,100}$/, "Invalid public key");

export const inspectInputSchema = z
  .object({
    transactionHash: cryptoHashSchema.optional(),
    senderAccountId: accountIdSchema.optional(),
    /** Base64 borsh SignedTransaction. Enables a definitive retry verdict. Never contains a private key. */
    signedTransactionBase64: z.string().min(80).max(2_000_000).optional(),
    nonce: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative(), z.bigint()]).optional(),
    publicKey: publicKeySchema.optional(),
    blockHash: cryptoHashSchema.optional(),
  })
  .refine((v) => v.signedTransactionBase64 || (v.transactionHash && v.senderAccountId), {
    message: "Provide signedTransactionBase64, or transactionHash + senderAccountId",
  });

export type InspectInput = z.input<typeof inspectInputSchema>;

export function parseOrThrow<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new SentinelInputError(r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), r.error.issues);
  }
  return r.data;
}
