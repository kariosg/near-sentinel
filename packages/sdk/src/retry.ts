/**
 * Safe-retry decision engine. PURE: takes gathered evidence, returns a verdict.
 *
 * Invariants (tested):
 *  - Missing/contradictory evidence never yields SAFE_TO_RETRY.
 *  - SAFE_TO_RETRY for a not-found tx requires, from >= `minIndependentOperators` distinct
 *    operators, a SELF-CONSISTENT proof on the SAME provider:
 *       (nonce consumed OR tx expired)  observed FIRST, at finality=final
 *       AND the provider holds the history window (has the tx's block_hash)
 *       AND that provider answered UNKNOWN_TRANSACTION AFTERWARDS.
 *    Per-provider consistency rules out lag between providers.
 *  - Re-broadcasting the IDENTICAL signed tx is always duplicate-safe on NEAR (same hash,
 *    same nonce): we recommend it whenever the tx might still land.
 */
import type { Confidence, RetryCheck, RetryRecommendation, TxState } from "./types.js";
import { plural } from "./text.js";

export interface PerProviderRetryEvidence {
  provider: string;
  operator: string;
  /** Final tx-status lookup (performed AFTER the access-key read). */
  txLookup: "FOUND" | "NOT_FOUND" | "ERROR";
  /** Access key nonce at finality=final; undefined = not queried / failed. */
  accessKeyNonce?: bigint;
  /** The access key does not exist (deleted, or never existed). */
  accessKeyMissing?: boolean;
  /** Final block height at which the access key was read. */
  observedFinalHeight?: number;
  /** Height of the tx's block_hash as reported by THIS provider (hash verified). */
  txBlockHeight?: number;
  /** Provider returned the tx's block_hash (so it holds the history window). null = unknown. */
  coversWindow: boolean | null;
}

export interface RetryEvidence {
  txHash: string;
  /** Present when at least one provider found the tx. */
  found?: {
    state: TxState;
    conflicting: boolean;
    /** Distinct operators whose answer shows the SAME failed outcome at final_execution_status FINAL. */
    finalFailureOperators?: number;
  };
  /**
   * True when nonce / publicKey / blockHash were decoded from the signed transaction itself.
   * Caller-supplied fields are not bound to the hash, so they can never justify SAFE_TO_RETRY.
   */
  fieldsFromSignedTx?: boolean;
  /** Signed-tx fields; absent when caller only gave a hash. */
  txNonce?: bigint;
  txBlockHash?: string;
  /** Height of txBlockHash, if any provider knows it (ETA display only; proofs use per-provider heights). */
  txBlockHeight?: number;
  validityPeriod: number;
  providers: PerProviderRetryEvidence[];
  minIndependentOperators: number;
  /** Average block time used only for human-readable ETAs. */
  blockTimeSeconds?: number;
}

const SAME_TX_REBROADCAST =
  "If you still hold the signed transaction, re-broadcasting the IDENTICAL bytes is duplicate-safe (same hash and nonce; NEAR executes it at most once). Never build and sign a NEW transaction for the same intent until this says SAFE_TO_RETRY.";

export function decideRetry(e: RetryEvidence): RetryRecommendation {
  const checks: RetryCheck[] = [];
  const rec = (
    verdict: RetryRecommendation["verdict"],
    confidence: Confidence,
    reason: string,
    nextAction: string,
    rebroadcastSameSignedTxIsSafe: boolean,
    recheckAfterSeconds?: number,
  ): RetryRecommendation => ({ verdict, confidence, reason, nextAction, rebroadcastSameSignedTxIsSafe, recheckAfterSeconds, checks });

  /* ---------------------------- found somewhere ---------------------------- */
  const foundBy = e.providers.filter((p) => p.txLookup === "FOUND");
  checks.push({
    id: "tx-found-by-any-provider",
    passed: foundBy.length > 0,
    detail: foundBy.length
      ? `Found by ${foundBy.map((p) => p.provider).join(", ")}`
      : `Not found by any of ${plural(e.providers.length, "provider")}`,
  });

  if (e.found) {
    if (e.found.conflicting) {
      return rec(
        "MANUAL_REVIEW_REQUIRED",
        "high",
        "Providers returned CONFLICTING final outcomes for this transaction. Sentinel will not pick a side.",
        "Compare the provider observations in the report; query an archival node you trust.",
        false,
      );
    }
    switch (e.found.state) {
      case "INCLUDED":
        return rec(
          "DO_NOT_RETRY",
          "high",
          "The transaction is already included on-chain and its receipts are still executing. A new transaction would execute the intent a second time.",
          "Wait a few seconds and re-check; do not sign anything new.",
          true,
          3,
        );
      case "EXECUTED_SUCCESS":
        return rec(
          "DO_NOT_RETRY",
          "high",
          "The transaction already executed successfully. Retrying would duplicate it.",
          "Treat the operation as done. Verify app-level effects if needed.",
          true,
        );
      case "PARTIALLY_COMPLETED":
        return rec(
          "MANUAL_REVIEW_REQUIRED",
          "high",
          "Part of the multi-receipt workflow succeeded and part failed. Re-running the whole intent could duplicate the parts that succeeded.",
          "Inspect the failed receipts and the state of contracts whose receipts succeeded; compensate or retry only the failed step.",
          true,
        );
      case "EXECUTED_FAILURE": {
        const ops = e.found.finalFailureOperators ?? 0;
        checks.push({
          id: "failure-final-on-independent-operators",
          passed: ops >= e.minIndependentOperators,
          detail: `${plural(ops, "independent operator")} report the same failed outcome at FINAL; ${e.minIndependentOperators} required`,
        });
        if (ops < e.minIndependentOperators) {
          return rec(
            "WAIT_AND_RECHECK",
            "medium",
            `The transaction was found and failed, but only ${plural(ops, "independent operator")} confirm that failure at FINAL (${e.minIndependentOperators} required). ` +
              "The others have not seen it yet, or no longer hold its history (non-archival nodes forget after ~5 epochs). Until enough confirm, it is not proven that no state change was applied.",
            "Re-check in a few seconds; for an older transaction, add an archival provider from another operator. Do not sign a new transaction yet.",
            true,
            3,
          );
        }
        return rec(
          "SAFE_TO_RETRY",
          "high",
          "The transaction executed and every non-refund receipt failed atomically, so no state change was applied (only gas was spent). A new transaction cannot duplicate it.",
          "Fix the failure cause shown in the diagnostics first — an unchanged retry will most likely fail the same way.",
          true,
        );
      }
      default:
        return rec("MANUAL_REVIEW_REQUIRED", "low", `Unexpected state ${e.found.state}.`, "Inspect manually.", false);
    }
  }

  /* --------------------------- not found anywhere --------------------------- */
  const answered = e.providers.filter((p) => p.txLookup === "NOT_FOUND");
  checks.push({
    id: "providers-answered",
    passed: answered.length > 0,
    detail: `${answered.length}/${plural(e.providers.length, "provider")} gave a definite UNKNOWN_TRANSACTION answer`,
  });
  if (answered.length === 0) {
    return rec(
      "WAIT_AND_RECHECK",
      "low",
      "No provider gave a definite answer (timeouts, rate limits or network errors). The transaction's fate is completely unknown.",
      `Re-check shortly. ${SAME_TX_REBROADCAST}`,
      true,
      10,
    );
  }

  if (e.txNonce === undefined) {
    checks.push({ id: "nonce-known", passed: null, detail: "No signed transaction / nonce supplied; cannot prove the tx will never land." });
    return rec(
      "WAIT_AND_RECHECK",
      "medium",
      "Not seen by any provider, but without the signed transaction (nonce, key, block_hash) Sentinel cannot prove it will never be included. Absence is not proof.",
      `Provide signedTransactionBase64 for a definitive answer. ${SAME_TX_REBROADCAST}`,
      true,
      5,
    );
  }

  const nonce = e.txNonce;
  const perProvider = e.providers.map((p) => {
    const consumed = p.accessKeyNonce !== undefined ? p.accessKeyNonce >= nonce : null;
    // Expiry uses THIS provider's own (hash-verified) height of the tx block, never another provider's.
    const expired =
      p.txBlockHeight !== undefined && p.observedFinalHeight !== undefined
        ? p.observedFinalHeight - p.txBlockHeight > e.validityPeriod
        : null;
    // A missing key is NOT proof: the key could be re-added and the tx could become valid again.
    // It only escalates to manual review.
    const provablyDead = consumed === true || expired === true;
    const canNeverLand = provablyDead || p.accessKeyMissing === true;
    const proof = p.txLookup === "NOT_FOUND" && p.coversWindow === true && provablyDead;
    return { p, consumed, expired, canNeverLand, proof };
  });

  for (const x of perProvider) {
    checks.push({
      id: `proof:${x.p.provider}`,
      passed: x.proof,
      detail:
        `lookup=${x.p.txLookup}, coversWindow=${x.p.coversWindow}, ` +
        `nonceConsumed=${x.consumed}${x.p.accessKeyNonce !== undefined ? ` (key nonce ${x.p.accessKeyNonce} vs tx ${nonce})` : ""}, ` +
        `keyMissing=${x.p.accessKeyMissing ?? null}, expired=${x.expired}`,
    });
  }

  const proofOperators = new Set(perProvider.filter((x) => x.proof).map((x) => x.p.operator));
  checks.push({
    id: "independent-operators",
    passed: proofOperators.size >= e.minIndependentOperators,
    detail: `${plural(proofOperators.size, "independent operator")} proved non-execution; ${e.minIndependentOperators} required`,
  });

  if (proofOperators.size >= e.minIndependentOperators && e.fieldsFromSignedTx !== true) {
    checks.push({
      id: "fields-bound-to-hash",
      passed: false,
      detail: "nonce / publicKey / blockHash were supplied separately, not decoded from the signed transaction, so they are not proven to belong to this hash.",
    });
    return rec(
      "MANUAL_REVIEW_REQUIRED",
      "medium",
      "The supplied nonce / key / block_hash look dead on enough independent providers, but they were not decoded from the signed transaction, so Sentinel cannot prove they belong to this transaction hash.",
      "Provide signedTransactionBase64 for a definitive answer. Do not sign anything new until then.",
      true,
    );
  }

  if (proofOperators.size >= e.minIndependentOperators) {
    return rec(
      "SAFE_TO_RETRY",
      "high",
      `${proofOperators.size} independent operators each show that this transaction can never be included any more ` +
        `(its nonce was consumed by another transaction, or it expired) AND that it does not exist in history they hold. ` +
        `The original will not execute, so a new transaction cannot duplicate it.`,
      "Build and sign a NEW transaction with a fresh nonce and a recent block_hash.",
      false,
    );
  }

  const anyNeverLand = perProvider.some((x) => x.canNeverLand);
  if (anyNeverLand) {
    return rec(
      "MANUAL_REVIEW_REQUIRED",
      "medium",
      "Evidence suggests the original can no longer land (nonce consumed / key missing / expired), but not enough independent providers that hold the relevant history confirmed it never executed.",
      "Add an archival provider from a different operator, or check the signer's recent activity in an explorer, before signing anything new.",
      false,
    );
  }

  // Could still land.
  let eta = "";
  if (e.txBlockHeight !== undefined) {
    const heights = perProvider.map((x) => x.p.observedFinalHeight).filter((h): h is number => h !== undefined);
    if (heights.length) {
      const remaining = e.txBlockHeight + e.validityPeriod - Math.max(...heights);
      eta =
        e.blockTimeSeconds !== undefined
          ? ` It remains valid for ~${remaining} more blocks (~${Math.round((remaining * e.blockTimeSeconds) / 60)} min at the measured ${e.blockTimeSeconds.toFixed(2)} s/block).`
          : ` It remains valid for ~${remaining} more blocks.`;
    }
  }
  const nonceRead = perProvider.some((x) => x.consumed === false);
  if (!nonceRead) {
    checks.push({ id: "may-still-land", passed: null, detail: "The access-key nonce could not be read from any provider; liveness is unknown." });
    return rec(
      "WAIT_AND_RECHECK",
      "low",
      "Not seen yet, and Sentinel could not read the signer's access-key nonce, so it cannot tell whether the transaction can still be included. Signing a new transaction now risks executing the intent twice.",
      `Re-check shortly. ${SAME_TX_REBROADCAST}`,
      true,
      10,
    );
  }
  checks.push({ id: "may-still-land", passed: false, detail: `Nonce not consumed and not expired.${eta}` });
  return rec(
    "WAIT_AND_RECHECK",
    "high",
    `Not seen yet, and it can STILL be included: its nonce is unused and its block_hash has not expired.${eta} Signing a new transaction now risks executing the intent twice.`,
    SAME_TX_REBROADCAST,
    true,
    5,
  );
}
