/**
 * Read-only check against a deployed Sentinel Vault contract (contracts/guard/vault).
 *
 * The vault holds an owner-funded allowance for an agent with a per-payment limit, a 24-hour limit and an
 * optional receiver allowlist; the agent spends with a function-call key that can only call `spend`.
 * This module asks every provider for `get_policy(owner_id, agent_id)` so an agent can learn, before it pays,
 * how much it may spend right now. It never signs or submits anything.
 */
import { z } from "zod";
import { decodeViewResult, INTENT_ID_RE } from "./intent.js";
import { formatNear, plural } from "./text.js";
import { isValidAccountId } from "./validation.js";

export const vaultInputSchema = z
  .object({
    contractId: z.string().refine(isValidAccountId, "Invalid vault contract account ID"),
    ownerId: z.string().refine(isValidAccountId, "Invalid owner account ID"),
    agentId: z.string().refine(isValidAccountId, "Invalid agent account ID"),
  })
  .strict();
export type VaultInput = z.infer<typeof vaultInputSchema>;

/** Exactly what the contract's `get_policy` returns (amounts in yoctoNEAR, as strings). */
export interface VaultPolicy {
  owner_id: string;
  agent_id: string;
  balance: string;
  per_payment_max: string;
  daily_max: string;
  spent_in_window: string;
  available_now: string;
  window_resets_at_ms: number;
  allowed_receivers: string[];
  frozen: boolean;
}

export type AllowanceStatus = "ACTIVE" | "EXHAUSTED" | "FROZEN" | "NO_POLICY" | "UNKNOWN";

export interface VaultProviderAnswer {
  provider: string;
  operator: string;
  answer: "POLICY" | "NO_POLICY" | "ERROR";
  policy?: VaultPolicy;
  error?: string;
  blockHeight?: number;
  latencyMs: number;
}

export interface AllowanceCheck {
  contractId: string;
  ownerId: string;
  agentId: string;
  status: AllowanceStatus;
  /** Policy from the provider at the highest block (freshest view). */
  policy?: VaultPolicy;
  /** Conservative: the SMALLEST `available_now` reported by any provider that has the policy (yoctoNEAR). */
  availableNow: string;
  reason: string;
  providers: VaultProviderAnswer[];
  checkedAt: string;
  /** How safe the freshest policy's limits are (present when a policy exists). Advisory. */
  safety?: AllowanceSafety;
}

const isAmount = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);

/** Strict shape check: the policy must be for exactly this owner and agent. */
export function isVaultPolicy(v: unknown, input: VaultInput): v is VaultPolicy {
  const x = v as VaultPolicy;
  return (
    !!x &&
    typeof x === "object" &&
    x.owner_id === input.ownerId &&
    x.agent_id === input.agentId &&
    [x.balance, x.per_payment_max, x.daily_max, x.spent_in_window, x.available_now].every(isAmount) &&
    typeof x.window_resets_at_ms === "number" &&
    Array.isArray(x.allowed_receivers) &&
    x.allowed_receivers.every((r) => typeof r === "string") &&
    typeof x.frozen === "boolean"
  );
}

/** Decode one provider's `get_policy` view answer. */
export function vaultAnswer(base: Omit<VaultProviderAnswer, "answer">, obs: Parameters<typeof decodeViewResult>[0], input: VaultInput): VaultProviderAnswer {
  const d = decodeViewResult(obs);
  if (d.kind === "error") return { ...base, answer: "ERROR", error: d.message };
  if (d.value === null) return { ...base, answer: "NO_POLICY" };
  return isVaultPolicy(d.value, input)
    ? { ...base, answer: "POLICY", policy: d.value }
    : { ...base, answer: "ERROR", error: "unexpected get_policy answer (not a Sentinel Vault policy for this owner and agent)" };
}

/** PURE: combine per-provider answers. Uses the freshest policy, but the smallest available amount. */
export function decideAllowance(input: VaultInput, providers: VaultProviderAnswer[]): Omit<AllowanceCheck, "checkedAt"> {
  const base = { ...input, providers };
  const withPolicy = providers.filter((p) => p.answer === "POLICY");
  const none = providers.filter((p) => p.answer === "NO_POLICY");
  if (withPolicy.length) {
    const freshest = withPolicy.reduce((a, b) => ((b.blockHeight ?? 0) > (a.blockHeight ?? 0) ? b : a));
    const policy = freshest.policy!;
    const availableNow = withPolicy.map((p) => BigInt(p.policy!.available_now)).reduce((a, b) => (b < a ? b : a)).toString();
    const limits = `per payment ${formatNear(policy.per_payment_max)} NEAR, per 24 h ${formatNear(policy.daily_max)} NEAR${policy.allowed_receivers.length ? `, only to ${policy.allowed_receivers.join(", ")}` : ""}`;
    if (withPolicy.some((p) => p.policy!.frozen))
      return { ...base, status: "FROZEN", policy, availableNow: "0", reason: "The owner has frozen this agent's spending. Do not attempt to pay; ask the owner." };
    if (availableNow === "0")
      return { ...base, status: "EXHAUSTED", policy, availableNow, reason: `Nothing can be spent right now (${limits}). The 24-hour window resets at ${new Date(policy.window_resets_at_ms).toISOString()}, or the owner must top up.` };
    return {
      ...base,
      status: "ACTIVE",
      policy,
      availableNow,
      reason: `Up to ${formatNear(availableNow)} NEAR can be spent now (${limits}). Use a fresh intent_id per payment; re-sending the SAME intent_id cannot pay twice.`,
    };
  }
  if (none.length)
    return { ...base, status: "NO_POLICY", availableNow: "0", reason: `${none.length}/${plural(providers.length, "provider")} report no policy for this owner and agent on this vault.` };
  return { ...base, status: "UNKNOWN", availableNow: "0", reason: "No provider answered (network errors, or the contract is not a Sentinel Vault). Treat as nothing available; re-check shortly." };
}

/* ------------------------------ spend preflight ------------------------------ */

/** The vault keeps this fee per spend (contracts/guard/vault RECORD_FEE: 0.006 NEAR), on top of the amount. */
export const VAULT_RECORD_FEE_YOCTO = "6000000000000000000000";
const U128_MAX = (1n << 128n) - 1n;
const DIGITS_RE = /^\d+$/;

export const preflightInputSchema = z
  .object({
    contractId: z.string().refine(isValidAccountId, "Invalid vault contract account ID"),
    ownerId: z.string().refine(isValidAccountId, "Invalid owner account ID"),
    agentId: z.string().refine(isValidAccountId, "Invalid agent account ID"),
    receiverId: z.string().refine(isValidAccountId, "Invalid receiver account ID"),
    amountYocto: z.string().max(80, "amountYocto is too long").regex(DIGITS_RE, "amountYocto: a whole number of yoctoNEAR (digits only)"),
    intentId: z.string().regex(INTENT_ID_RE, "intentId: 1-64 chars of A-Z a-z 0-9 . _ : -").optional(),
  })
  .strict();
export type PreflightInput = z.infer<typeof preflightInputSchema>;

export type PreflightCode =
  | "INVALID_INTENT_ID"
  | "INVALID_AMOUNT"
  | "INVALID_RECEIVER"
  | "DUPLICATE_INTENT"
  | "NO_POLICY"
  | "FROZEN"
  | "NOT_ALLOWED_RECEIVER"
  | "OVER_PER_PAYMENT_LIMIT"
  | "OVER_DAILY_LIMIT"
  | "INSUFFICIENT_VAULT_BALANCE";

export const PREFLIGHT_ADVISORY = "Advisory: the Vault contract is the final judge and enforces these same rules on-chain." as const;

export interface SpendPreflight {
  decision: "ALLOWED" | "BLOCKED" | "UNKNOWN";
  code?: PreflightCode;
  reason: string;
  /** yoctoNEAR the receiver would get. */
  amount: string;
  /** yoctoNEAR taken from the vault balance: amount + the 0.006 NEAR record fee. */
  costYocto: string;
  receiverId: string;
  intentId?: string;
  /** true: a provider already has a spend record for this intent; false: none has; absent: not checked / unknown. */
  duplicate?: boolean;
  advisory: typeof PREFLIGHT_ADVISORY;
  allowance: AllowanceCheck;
  checkedAt: string;
}

export interface PreflightSpend {
  receiverId: string;
  /** yoctoNEAR, digits only. */
  amount: string;
  intentId?: string;
  /** `get_spend` lookup: true if any provider has a record; false if none has; undefined if not checked or no provider answered. */
  duplicate?: boolean;
}

/**
 * PURE: would the Vault's `spend()` accept this payment? Mirrors the contract's check order
 * (amount, receiver is not the vault, duplicate intent, policy, frozen, allowlist, per-payment, 24 h, balance)
 * against EVERY provider's policy, so a payment is only called ALLOWED if no provider's view would reject it
 * and it does not exceed the smallest `available_now` any provider reports. Advisory only.
 */
export function decideSpendPreflight(allowance: AllowanceCheck, spend: PreflightSpend, now = Date.now()): Omit<SpendPreflight, "checkedAt"> {
  const digits = DIGITS_RE.test(spend.amount);
  const amount = digits ? BigInt(spend.amount) : 0n;
  const fee = BigInt(VAULT_RECORD_FEE_YOCTO);
  const amountStr = digits ? amount.toString() : spend.amount;
  const base = {
    amount: amountStr,
    costYocto: (amount + fee).toString(),
    receiverId: spend.receiverId,
    ...(spend.intentId !== undefined ? { intentId: spend.intentId } : {}),
    ...(spend.duplicate !== undefined ? { duplicate: spend.duplicate } : {}),
    advisory: PREFLIGHT_ADVISORY,
    allowance,
  };
  const blocked = (code: PreflightCode, reason: string) => ({ ...base, decision: "BLOCKED" as const, code, reason: `Blocked (${code}): ${reason}` });
  const unknown = (reason: string) => ({ ...base, decision: "UNKNOWN" as const, reason });

  // Same order as spend(): validate_intent_id runs first; a malformed receiver could not even be deserialized.
  if (spend.intentId !== undefined && !INTENT_ID_RE.test(spend.intentId)) return blocked("INVALID_INTENT_ID", "the payment ID must be 1-64 characters of A-Z a-z 0-9 . _ : -");
  if (!isValidAccountId(spend.receiverId)) return blocked("INVALID_RECEIVER", "the receiver is not a valid NEAR account ID.");
  if (!digits || amount <= 0n || amount > U128_MAX) return blocked("INVALID_AMOUNT", "the amount must be a whole number of yoctoNEAR greater than 0.");
  if (spend.receiverId === allowance.contractId) return blocked("INVALID_RECEIVER", "the vault cannot pay itself.");
  if (spend.duplicate === true)
    return blocked("DUPLICATE_INTENT", `intent ID ${spend.intentId} was already used by this agent. Re-sending it cannot pay twice; use a fresh ID for a new payment.`);
  if (allowance.status === "UNKNOWN") return unknown(`Cannot tell: ${allowance.reason}`);
  if (allowance.status === "NO_POLICY") return blocked("NO_POLICY", `the owner has no policy for this agent on this vault. ${allowance.reason}`);
  if (allowance.status === "FROZEN") return blocked("FROZEN", "the owner has frozen this agent's spending. Ask the owner.");

  const policies = allowance.providers.filter((p) => p.answer === "POLICY" && p.policy).map((p) => p.policy!);
  if (!policies.length && allowance.policy) policies.push(allowance.policy);
  if (!policies.length) return unknown("Cannot tell: no provider returned the policy.");
  const shown = allowance.policy ?? policies[0]!;
  const min = (xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

  if (policies.some((p) => p.allowed_receivers.length > 0 && !p.allowed_receivers.includes(spend.receiverId)))
    return blocked("NOT_ALLOWED_RECEIVER", `${spend.receiverId} is not on the owner's allowlist (${shown.allowed_receivers.join(", ") || "none"}).`);
  if (policies.some((p) => amount > BigInt(p.per_payment_max)))
    return blocked("OVER_PER_PAYMENT_LIMIT", `${formatNear(amountStr)} NEAR is over the per-payment limit of ${formatNear(min(policies.map((p) => BigInt(p.per_payment_max))).toString())} NEAR.`);
  // The contract rolls the 24-hour window before this check: once the reset time has passed, nothing counts as spent.
  const left = (p: VaultPolicy) => {
    const spent = p.window_resets_at_ms <= now ? 0n : BigInt(p.spent_in_window);
    const max = BigInt(p.daily_max);
    return max > spent ? max - spent : 0n;
  };
  const dayLeft = min(policies.map(left));
  if (amount > dayLeft)
    return blocked(
      "OVER_DAILY_LIMIT",
      `${formatNear(amountStr)} NEAR is more than the ${formatNear(dayLeft.toString())} NEAR left of the 24-hour limit (${formatNear(shown.daily_max)} NEAR). The window resets at ${new Date(shown.window_resets_at_ms).toISOString()}.`,
    );
  const minBalance = min(policies.map((p) => BigInt(p.balance)));
  if (amount + fee > minBalance)
    return blocked(
      "INSUFFICIENT_VAULT_BALANCE",
      `the payment plus the 0.006 NEAR record fee (${formatNear(base.costYocto)} NEAR) is more than the vault balance of ${formatNear(minBalance.toString())} NEAR. The owner must top up.`,
    );
  if (amount > BigInt(allowance.availableNow))
    return unknown(`The rules pass, but a provider reports only ${formatNear(allowance.availableNow)} NEAR available now (its view may predate the 24-hour window reset). Re-check shortly.`);
  if (spend.intentId !== undefined && spend.duplicate === undefined)
    return unknown(`The limits allow ${formatNear(amountStr)} NEAR to ${spend.receiverId}, but no provider answered whether intent ID ${spend.intentId} was already used. Re-check shortly.`);
  return {
    ...base,
    decision: "ALLOWED",
    reason: `Allowed: ${formatNear(amountStr)} NEAR to ${spend.receiverId} fits every rule (vault cost ${formatNear(base.costYocto)} NEAR with the record fee).${spend.intentId ? "" : " Use a fresh intent ID for this payment."}`,
  };
}

/* ------------------------------ allowance safety ------------------------------ */

export interface AllowanceSafety {
  /** 0-100: 100 minus 35 per high, 15 per medium, 5 per low finding. */
  score: number;
  grade: "strong" | "fair" | "weak";
  findings: Array<{ severity: "high" | "medium" | "low" | "info"; title: string; fix?: string }>;
}

/** PURE: how safe are this policy's limits if the agent is tricked or its key leaks? Advisory. */
export function assessAllowanceSafety(policy: VaultPolicy): AllowanceSafety {
  const findings: AllowanceSafety["findings"] = [];
  if (policy.allowed_receivers.length === 0)
    findings.push({ severity: "high", title: "Any receiver allowed: a tricked agent could pay anyone.", fix: "Set allowed_receivers to the few accounts this agent should pay." });
  if (policy.allowed_receivers.includes(policy.agent_id))
    findings.push({ severity: "high", title: "The agent can pay itself, moving funds outside the vault's limits.", fix: "Remove the agent's own account from allowed_receivers." });
  if (policy.per_payment_max === policy.daily_max)
    findings.push({ severity: "medium", title: "One payment can use the whole 24-hour limit.", fix: "Set per_payment_max below daily_max." });
  const balance = BigInt(policy.balance);
  if (balance > 0n && BigInt(policy.daily_max) >= balance)
    findings.push({ severity: "medium", title: "The 24-hour limit is at least the vault balance: one day can empty it.", fix: "Lower daily_max, or keep less in the vault and top up as needed." });
  if (policy.frozen) findings.push({ severity: "info", title: "Frozen: spending is paused, which is safe." });
  const penalty = { high: 35, medium: 15, low: 5, info: 0 } as const;
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + penalty[f.severity], 0));
  return { score, grade: score >= 80 ? "strong" : score >= 50 ? "fair" : "weak", findings };
}
