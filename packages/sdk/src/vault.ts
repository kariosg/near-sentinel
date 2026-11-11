/**
 * Read-only check against a deployed Sentinel Vault contract (contracts/guard/vault).
 *
 * The vault holds an owner-funded allowance for an agent with a per-payment limit, a 24-hour limit and an
 * optional receiver allowlist; the agent spends with a function-call key that can only call `spend`.
 * This module asks every provider for `get_policy(owner_id, agent_id)` so an agent can learn, before it pays,
 * how much it may spend right now. It never signs or submits anything.
 */
import { z } from "zod";
import { decodeViewResult } from "./intent.js";
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
