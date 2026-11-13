/**
 * Agent-side spend guard: the code path between "the model wants to pay" and "a transaction is signed".
 *
 * An LLM can be talked into anything by text it reads (a prompt-injected invoice, web page or tool output), so the
 * decision to sign must not depend on the model following instructions. `guardedSpend` runs Sentinel's preflight and
 * then, deterministically:
 *   - SIGN       → calls `sign` once;
 *   - ASK_HUMAN  → calls `confirm` (a human), and signs only on an explicit yes; with no `confirm`, it refuses;
 *   - REFUSE     → never calls `sign`.
 * Any error before signing (network, invalid input) also refuses. Sentinel itself never signs: `sign` is the
 * caller's code, holding the agent's function-call key that can only call the vault's `spend`.
 */
import type { PreflightInput, SpendAction, SpendPreflight } from "./vault.js";

export interface GuardedSpendLog {
  step: "preflight" | "human" | "sign" | "refuse";
  message: string;
}

export interface GuardedSpendOptions<T> {
  /** Anything with `preflightSpend`, normally a `NearSentinel`. */
  sentinel: { preflightSpend(input: PreflightInput): Promise<SpendPreflight> };
  /** The payment. `intentId` is required so a retry after a timeout can never pay twice (the vault enforces it). */
  spend: PreflightInput & { intentId: string };
  /** Signs and sends the vault `spend()`. Called at most once, and only on SIGN or a human's explicit yes. */
  sign: (preflight: SpendPreflight) => Promise<T>;
  /** Asked when the action is ASK_HUMAN. Without it, the guard fails closed and refuses. */
  confirm?: (preflight: SpendPreflight) => Promise<boolean>;
  /** Receives one line per step, for the agent's audit log. */
  log?: (entry: GuardedSpendLog) => void;
}

export type GuardedSpendResult<T> =
  | { outcome: "SIGNED"; action: SpendAction; humanApproved: boolean; preflight: SpendPreflight; result: T }
  | { outcome: "REFUSED"; action?: SpendAction; reason: string; preflight?: SpendPreflight };

export async function guardedSpend<T>(opts: GuardedSpendOptions<T>): Promise<GuardedSpendResult<T>> {
  const log = opts.log ?? (() => {});
  const refuse = (reason: string, preflight?: SpendPreflight): GuardedSpendResult<T> => {
    log({ step: "refuse", message: reason });
    return { outcome: "REFUSED", ...(preflight ? { action: preflight.action, preflight } : {}), reason };
  };

  let pre: SpendPreflight;
  try {
    pre = await opts.sentinel.preflightSpend(opts.spend);
  } catch (e) {
    return refuse(`Refused: the preflight failed (${e instanceof Error ? e.message : String(e)}). Not signing without a verdict.`);
  }
  log({ step: "preflight", message: `${pre.decision}${pre.code ? ` (${pre.code})` : ""}, receiver ${pre.receiverCheck?.status ?? "not checked"} → ${pre.action}. ${pre.actionReason}` });

  if (pre.action === "REFUSE") return refuse(pre.actionReason, pre);
  let humanApproved = false;
  if (pre.action === "ASK_HUMAN") {
    if (!opts.confirm) return refuse(`${pre.actionReason} No human is configured to confirm, so the guard refuses.`, pre);
    let yes = false;
    try {
      yes = (await opts.confirm(pre)) === true;
    } catch {
      yes = false;
    }
    log({ step: "human", message: yes ? "A human approved this payment." : "A human declined (or did not answer)." });
    if (!yes) return refuse("Refused: a human did not approve the payment.", pre);
    humanApproved = true;
  } else if (pre.action !== "SIGN") {
    return refuse(`Refused: unexpected action ${String(pre.action)}.`, pre);
  }

  log({ step: "sign", message: `Signing spend(${opts.spend.intentId}): ${pre.amount} yoctoNEAR to ${pre.receiverId}.` });
  const result = await opts.sign(pre);
  return { outcome: "SIGNED", action: pre.action, humanApproved, preflight: pre, result };
}
