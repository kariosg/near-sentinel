/**
 * Optional "Verify NEAR account" (NEP-413 signed message). Purely a label for the dashboard user:
 * nothing is stored server-side except short-lived single-use nonces, no session is created, and
 * every Sentinel feature works without it.
 *
 * NEP-413: signature = ed25519_sign( sha256( u32le(2^31 + 413) || borsh({ message, nonce[32], recipient, callbackUrl? }) ) )
 */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";

export const NEP413_TAG = 2 ** 31 + 413;
export const IDENTITY_RECIPIENT = "near-sentinel";
export const IDENTITY_MESSAGE =
  "Verify my NEAR account for NEAR Sentinel. This signature only proves account ownership; it cannot move funds or authorize transactions.";
const NONCE_TTL_MS = 5 * 60_000;
const MAX_PENDING = 10_000;

/* --------------------------------- base58 --------------------------------- */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) throw new Error("invalid base58");
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/* --------------------------------- payload -------------------------------- */

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** sha256 of the NEP-413 tagged, borsh-serialized payload (what the wallet signs). */
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Buffer {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]);
  const payload = Buffer.concat([borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient), cb]);
  return createHash("sha256").update(Buffer.concat([tag, payload])).digest();
}

/** Raw 32-byte ed25519 public key → Node KeyObject. */
export function ed25519PublicKey(raw: Uint8Array) {
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(raw)]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

export function parseNearPublicKey(pk: string): Uint8Array {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,50})$/.exec(pk);
  if (!m) throw new Error("publicKey must be ed25519:<base58>");
  const raw = base58Decode(m[1]!);
  if (raw.length !== 32) throw new Error("publicKey must decode to 32 bytes");
  return raw;
}

/**
 * Verify a NEP-413 signature. Wallets differ on whether the callbackUrl is part of the signed
 * payload, so both forms are accepted (nonce and recipient are always bound).
 */
export function verifyNep413(args: { publicKey: string; signatureBase64: string; message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): boolean {
  const key = ed25519PublicKey(parseNearPublicKey(args.publicKey));
  const sig = Buffer.from(args.signatureBase64, "base64");
  if (sig.length !== 64) return false;
  const forms = [undefined, ...(args.callbackUrl ? [args.callbackUrl] : [])];
  return forms.some((cb) => verify(null, nep413Hash({ message: args.message, nonce: args.nonce, recipient: args.recipient, callbackUrl: cb }), key, sig));
}

/* ------------------------------ nonce store ------------------------------ */

export class NonceStore {
  private pending = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  issue(): { nonce: string; expiresAt: string } {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) throw Object.assign(new Error("Too many pending verifications; try again shortly"), { statusCode: 429 });
    const nonce = randomBytes(32).toString("base64");
    const exp = this.now() + NONCE_TTL_MS;
    this.pending.set(nonce, exp);
    return { nonce, expiresAt: new Date(exp).toISOString() };
  }

  /** Single use: returns true once for a live nonce, then forgets it. */
  consume(nonce: string): boolean {
    const exp = this.pending.get(nonce);
    this.pending.delete(nonce);
    return exp !== undefined && exp >= this.now();
  }

  private sweep() {
    const t = this.now();
    for (const [n, exp] of this.pending) if (exp < t) this.pending.delete(n);
  }
}
