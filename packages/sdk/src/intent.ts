/**
 * Read-only check against a deployed Sentinel Guard contract (contracts/guard).
 *
 * The contract forwards a payment at most once per (payer, intent_id). This module asks every
 * provider for `get_intent(payer_id, intent_id)` and returns what the chain says, with evidence.
 * It never signs or submits anything.
 */
import { z } from "zod";
import { formatNear, plural } from "./text.js";
import type { RpcObservation } from "./types.js";
import { isValidAccountId } from "./validation.js";

export const INTENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export const intentInputSchema = z
  .object({
    contractId: z.string().refine(isValidAccountId, "Invalid contract account ID"),
    payerId: z.string().refine(isValidAccountId, "Invalid payer account ID"),
    intentId: z.string().regex(INTENT_ID_RE, "intentId: 1-64 chars of A-Z a-z 0-9 . _ : -"),
  })
  .strict();
export type IntentInput = z.infer<typeof intentInputSchema>;

export interface GuardIntent {
  payer_id: string;
  intent_id: string;
  receiver_id: string;
  /** yoctoNEAR forwarded to the receiver */
  amount: string;
  block_height: number;
  status: "Pending" | "Paid";
}

export type IntentStatus = "PAID" | "PENDING" | "NOT_RECORDED" | "CONFLICTING" | "UNKNOWN";

export interface IntentProviderAnswer {
  provider: string;
  operator: string;
  answer: "RECORDED" | "NOT_RECORDED" | "ERROR";
  intent?: GuardIntent;
  error?: string;
  blockHeight?: number;
  latencyMs: number;
}

export interface IntentCheck {
  contractId: string;
  payerId: string;
  intentId: string;
  status: IntentStatus;
  intent?: GuardIntent;
  /** Never sign a payment for this intent through any path other than the guard contract. */
  doNotPayOutsideGuard: true;
  /** Calling the guard's pay() again with the SAME intent_id cannot double-pay: the contract rejects duplicates. */
  resendSameIntentIsSafe: boolean;
  reason: string;
  providers: IntentProviderAnswer[];
  checkedAt: string;
}

/** Decode a `call_function` view result (`result.result` is the UTF-8 JSON bytes). */
export function decodeViewResult(obs: RpcObservation<any>): { kind: "value"; value: unknown } | { kind: "error"; message: string } {
  if (!obs.ok) return { kind: "error", message: obs.error?.message ?? "request failed" };
  const r = obs.result;
  if (r && typeof r.error === "string") return { kind: "error", message: r.error };
  if (!r || !Array.isArray(r.result)) return { kind: "error", message: "malformed view result" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(r.result as number[]));
    return { kind: "value", value: JSON.parse(text) };
  } catch {
    return { kind: "error", message: "view result is not valid UTF-8 JSON" };
  }
}

/** Strict shape check: the record must be for exactly this payer and intent. */
export function isGuardIntent(v: unknown, input: IntentInput): v is GuardIntent {
  const x = v as GuardIntent;
  return (
    !!x &&
    typeof x === "object" &&
    x.payer_id === input.payerId &&
    x.intent_id === input.intentId &&
    typeof x.receiver_id === "string" &&
    typeof x.amount === "string" &&
    /^\d+$/.test(x.amount) &&
    typeof x.block_height === "number" &&
    (x.status === "Pending" || x.status === "Paid")
  );
}

/** PURE: combine per-provider answers into one result. Positive evidence wins; disagreement is surfaced. */
export function decideIntent(input: IntentInput, providers: IntentProviderAnswer[]): Omit<IntentCheck, "checkedAt"> {
  const base = { ...input, doNotPayOutsideGuard: true as const, providers };
  const recorded = providers.filter((p) => p.answer === "RECORDED");
  const notRecorded = providers.filter((p) => p.answer === "NOT_RECORDED");

  if (recorded.length) {
    const distinct = new Set(recorded.map((p) => `${p.intent!.receiver_id}|${p.intent!.amount}|${p.intent!.block_height}`));
    if (distinct.size > 1) {
      return { ...base, status: "CONFLICTING", resendSameIntentIsSafe: true, reason: "Providers return different records for this intent. Compare the evidence; the contract still rejects a duplicate pay()." };
    }
    // Prefer the most advanced status (Paid beats Pending: a lagging node may still show Pending).
    const best = recorded.find((p) => p.intent!.status === "Paid") ?? recorded[0]!;
    const intent = best.intent!;
    return intent.status === "Paid"
      ? { ...base, status: "PAID", intent, resendSameIntentIsSafe: true, reason: `Already paid: ${formatNear(intent.amount)} NEAR to ${intent.receiver_id} (block ${intent.block_height}). Do NOT pay again by any other route.` }
      : { ...base, status: "PENDING", intent, resendSameIntentIsSafe: true, reason: `Recorded and the transfer to ${intent.receiver_id} is in flight. Re-check in a few seconds; do not pay by any other route.` };
  }
  if (notRecorded.length) {
    return {
      ...base,
      status: "NOT_RECORDED",
      resendSameIntentIsSafe: true,
      reason:
        `${notRecorded.length}/${plural(providers.length, "provider")} show no record. Your pay() may not have landed yet, or it was refunded. ` +
        "Calling pay() again with the SAME intent_id is safe: if the first call lands, the contract rejects the second with DUPLICATE_INTENT and refunds it.",
    };
  }
  return { ...base, status: "UNKNOWN", resendSameIntentIsSafe: true, reason: "No provider answered (network errors, or the contract does not exist / is not a Sentinel Guard). Re-check shortly." };
}
