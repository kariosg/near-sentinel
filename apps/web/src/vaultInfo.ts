/**
 * Plain-language helpers for the Sentinel Vault and Guard panels: amounts, status meanings and
 * friendly explanations of contract errors. Pure functions (no React), so tests can import them directly.
 */

/** yoctoNEAR string → NEAR with up to 4 decimals ("198270000000000000000000" → "0.1982"). Never rounds up. */
export function nearOf(y: string): string {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-24).replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
}

/** yoctoNEAR string → NEAR with all 24 decimals, trailing zeros removed. Exact, for "Max" buttons. */
export function nearExact(y: string): string {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** a − b on yoctoNEAR strings, floored at 0. */
export const subYocto = (a: string, b: string): string => {
  const d = BigInt(a) - BigInt(b);
  return (d > 0n ? d : 0n).toString();
};

/** Each spend stores a pay-once record; the contract takes this from the vault balance (RECORD_FEE in contracts/guard/vault/src/lib.rs). */
export const RECORD_FEE_NEAR = "0.006";

/** NEAR charges 10^19 yoctoNEAR (0.00001 NEAR) per byte of account storage. */
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;

export const VAULT_STATUS_HELP: Record<string, string> = {
  ACTIVE: "The agent can pay now, within the limits below. Nothing to do.",
  EXHAUSTED: "The agent can't pay right now: the 24-hour limit is used up or the balance is too low. Wait for the window to reset, or the owner adds funds (Fund).",
  FROZEN: "The owner paused this agent. Only the owner can unfreeze it (Owner actions → Freeze / unfreeze).",
  NO_POLICY: "This owner has no allowance for this agent yet. The owner creates one with Owner actions → Fund.",
  UNKNOWN: "Providers did not give a usable answer. Nothing is assumed; try again in a moment.",
};

export const GUARD_STATUS_HELP: Record<string, string> = {
  PAID: "This intent was paid once. Never pay it again by any other route; a repeat through the Guard is refused and refunded.",
  PENDING: "The payment is in flight. Wait a few seconds and check again before doing anything.",
  NOT_RECORDED: "The Guard has no payment for this intent. It is safe to pay it through the Guard.",
  CONFLICTING: "Providers disagree about this intent. Do not pay; check again in a moment, and escalate to a human if it persists.",
  UNKNOWN: "Providers did not give a usable answer. Nothing is assumed; check again before paying.",
};

const ERRORS: Array<[RegExp, string]> = [
  [/INSUFFICIENT_VAULT_BALANCE/, "The vault does not hold that much. Use Max to withdraw the exact balance (a new allowance keeps a small part of the first deposit for NEAR storage)."],
  [/INSUFFICIENT_DEPOSIT/, "The deposit does not cover the storage this allowance needs (more receivers need more storage). Attach a little more NEAR, e.g. 0.02."],
  [/NO_POLICY/, "This account has no allowance for that agent. You can only manage allowances you funded as the owner: connect the owner's wallet, or create one with Fund."],
  [/FROZEN/, "The owner has frozen this agent, so it cannot pay. The owner can unfreeze it in Freeze / unfreeze."],
  [/OVER_PER_PAYMENT_LIMIT/, "The payment is above the per-payment limit the owner set."],
  [/OVER_DAILY_LIMIT/, "This payment would go over the 24-hour limit. Wait for the window to reset, or the owner raises the limit."],
  [/NOT_ALLOWED_RECEIVER/, "The receiver is not on the owner's allowlist."],
  [/DUPLICATE_INTENT/, "This intent was already used: it can be paid only once. Use a new intent id for a new payment."],
  [/INVALID_POLICY: per_payment_max must be <= daily_max/, "The per-payment limit must not be higher than the 24-hour limit."],
  [/INVALID_POLICY: per_payment_max must be > 0/, "The per-payment limit must be more than 0."],
  [/INVALID_POLICY: at most 20/, "Use at most 20 allowed receivers."],
  [/INVALID_POLICY: the vault cannot be a receiver|INVALID_RECEIVER/, "The vault contract itself cannot be a receiver."],
  [/INVALID_AMOUNT/, "The amount must be more than 0."],
  [/INVALID_INTENT_ID/, "The intent id must be 1 to 64 characters."],
  [/NotEnoughBalance|LackBalanceForState|not enough balance/i, "Your wallet does not have enough NEAR for this deposit plus gas. Top it up from the testnet faucet."],
  [/reject|cancel|denied|closed/i, "Cancelled in the wallet. Nothing was sent."],
];

/** A plain sentence for a contract or wallet error; falls back to the raw text. */
export function friendlyVaultError(raw: string): string {
  for (const [re, text] of ERRORS) if (re.test(raw)) return text;
  return raw;
}
