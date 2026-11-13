/** NEAR Sentinel as agent tools (read-only). Each tool maps its evidence to the decisions that evidence allows. */
import type { NearSentinel } from "@near-sentinel/sdk";
import type { Decision, ToolImpl } from "./agent.js";

const VERDICT_ALLOWS: Record<string, Decision[]> = {
  DO_NOT_RETRY: ["DO_NOT_PAY_AGAIN"],
  WAIT_AND_RECHECK: ["WAIT"],
  MANUAL_REVIEW_REQUIRED: ["ESCALATE"],
  SAFE_TO_RETRY: ["PAY_AGAIN", "WAIT"],
};

const near = (yocto: string) => {
  const s = yocto.padStart(25, "0");
  const frac = s.slice(-24, -20).replace(/0+$/, "");
  return `${s.slice(0, -24).replace(/^0+(?=\d)/, "")}${frac ? "." + frac : ""}`;
};

/** Agent action from preflight_spend → decisions it allows (the first is the safe default). */
export const ACTION_ALLOWS: Record<string, Decision[]> = {
  SIGN: ["PAY", "DO_NOT_PAY"],
  ASK_HUMAN: ["ESCALATE", "DO_NOT_PAY"],
  REFUSE: ["DO_NOT_PAY"],
};

/** `intended`: the payment the agent wants to make from an allowance (used to judge check_spend_allowance). */
export function sentinelTools(sentinel: NearSentinel, intended?: { amountYocto: bigint; receiverId: string }): Record<string, ToolImpl> {
  return {
    async check_retry_safety(a) {
      const r = await sentinel.checkRetrySafety({ transactionHash: String(a.transactionHash), senderAccountId: String(a.senderAccountId) });
      const found = r.inspection.providers.filter((p) => p.outcome === "FOUND").length;
      return {
        forModel: { verdict: r.verdict, state: r.state, confidence: r.recommendation.confidence, reason: r.recommendation.reason, nextAction: r.recommendation.nextAction, providersFound: `${found}/${r.inspection.providers.length}` },
        allows: VERDICT_ALLOWS[r.verdict] ?? ["ESCALATE"],
        summary: `${r.verdict} (${r.state}); found by ${found}/${r.inspection.providers.length} providers`,
      };
    },
    async preflight_spend(a) {
      const r = await sentinel.preflightSpend({
        contractId: String(a.contractId),
        ownerId: String(a.ownerId),
        agentId: String(a.agentId),
        receiverId: String(a.receiverId),
        amountYocto: String(a.amountYocto),
        ...(a.intentId !== undefined ? { intentId: String(a.intentId) } : {}),
      });
      return {
        forModel: { action: r.action, actionReason: r.actionReason, decision: r.decision, code: r.code ?? null, receiverCheck: r.receiverCheck?.status ?? null, amountNear: near(r.amount) },
        allows: ACTION_ALLOWS[r.action] ?? ["DO_NOT_PAY"],
        summary: `${r.action}: ${r.decision}${r.code ? ` (${r.code})` : ""}, receiver ${r.receiverCheck?.status ?? "not checked"}`,
      };
    },
    async check_spend_allowance(a) {
      const r = await sentinel.checkSpendAllowance({ contractId: String(a.contractId), ownerId: String(a.ownerId), agentId: String(a.agentId) });
      const p = r.policy;
      let allows: Decision[] = ["DO_NOT_PAY"];
      let why = r.reason;
      if (r.status === "ACTIVE" && p && intended) {
        const okAmount = intended.amountYocto <= BigInt(r.availableNow);
        const okReceiver = p.allowed_receivers.length === 0 || p.allowed_receivers.includes(intended.receiverId);
        if (okAmount && okReceiver) allows = ["PAY", "DO_NOT_PAY"];
        why = !okReceiver ? `${intended.receiverId} is not on the owner's allowlist (${p.allowed_receivers.join(", ")})` : !okAmount ? `the payment is above the ${near(r.availableNow)} NEAR available now` : "within the policy";
      }
      return {
        forModel: { status: r.status, availableNowNear: near(r.availableNow), perPaymentMaxNear: p ? near(p.per_payment_max) : null, dailyMaxNear: p ? near(p.daily_max) : null, allowedReceivers: p?.allowed_receivers ?? [], frozen: p?.frozen ?? null, judgement: why },
        allows,
        summary: `${r.status}, available now ${near(r.availableNow)} NEAR: ${why}`,
      };
    },
  };
}
