import { describe, expect, it } from "vitest";
import { decideRetry, type PerProviderRetryEvidence, type RetryEvidence } from "../src/retry.js";

const P = (over: Partial<PerProviderRetryEvidence> & { provider: string; operator: string }): PerProviderRetryEvidence => ({
  txLookup: "NOT_FOUND",
  coversWindow: true,
  ...over,
});

const base = (over: Partial<RetryEvidence> = {}): RetryEvidence => ({
  txHash: "h",
  validityPeriod: 86_400,
  minIndependentOperators: 2,
  providers: [],
  fieldsFromSignedTx: true, // default: fields decoded from the signed tx (the definitive path)
  ...over,
});

describe("retry decision table", () => {
  describe("transaction found by a provider", () => {
    it.each([
      ["EXECUTED_SUCCESS", "DO_NOT_RETRY"],
      ["INCLUDED", "DO_NOT_RETRY"],
      ["PARTIALLY_COMPLETED", "MANUAL_REVIEW_REQUIRED"],
      ["EXECUTED_FAILURE", "SAFE_TO_RETRY"],
    ] as const)("%s → %s", (state, verdict) => {
      const r = decideRetry(base({ found: { state, conflicting: false, finalFailureOperators: 2 }, providers: [P({ provider: "a", operator: "x", txLookup: "FOUND" })] }));
      expect(r.verdict).toBe(verdict);
      expect(r.confidence).toBe("high");
      expect(r.checks.find((c) => c.id === "tx-found-by-any-provider")?.passed).toBe(true);
    });

    it.each([0, 1])("EXECUTED_FAILURE confirmed FINAL by only %i operator(s) → WAIT_AND_RECHECK, never SAFE", (ops) => {
      const r = decideRetry(base({ found: { state: "EXECUTED_FAILURE", conflicting: false, finalFailureOperators: ops } }));
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
      expect(r.rebroadcastSameSignedTxIsSafe).toBe(true);
      expect(r.checks.find((c) => c.id === "failure-final-on-independent-operators")?.passed).toBe(false);
    });

    it("conflicting outcomes → MANUAL_REVIEW_REQUIRED, never a side picked", () => {
      const r = decideRetry(base({ found: { state: "EXECUTED_SUCCESS", conflicting: true } }));
      expect(r.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    });

    it("INCLUDED asks to recheck soon and allows rebroadcast of the same bytes", () => {
      const r = decideRetry(base({ found: { state: "INCLUDED", conflicting: false } }));
      expect(r.recheckAfterSeconds).toBeGreaterThan(0);
      expect(r.rebroadcastSameSignedTxIsSafe).toBe(true);
    });
  });

  describe("transaction not found anywhere", () => {
    it("no provider answered (all ERROR) → WAIT_AND_RECHECK, low confidence", () => {
      const r = decideRetry(
        base({ txNonce: 5n, providers: [P({ provider: "a", operator: "x", txLookup: "ERROR" }), P({ provider: "b", operator: "y", txLookup: "ERROR" })] }),
      );
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
      expect(r.confidence).toBe("low");
    });

    it("hash only (no nonce) → never SAFE, even if everyone says not found", () => {
      const r = decideRetry(base({ providers: [P({ provider: "a", operator: "x" }), P({ provider: "b", operator: "y" })] }));
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
      expect(r.reason).toMatch(/Absence is not proof/);
    });

    it("nonce consumed + covered + not found on 2 independent operators → SAFE_TO_RETRY", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 11n, observedFinalHeight: 100 }),
            P({ provider: "b", operator: "y", accessKeyNonce: 10n, observedFinalHeight: 100 }),
          ],
        }),
      );
      expect(r.verdict).toBe("SAFE_TO_RETRY");
      expect(r.confidence).toBe("high");
      expect(r.rebroadcastSameSignedTxIsSafe).toBe(false);
      expect(r.checks.find((c) => c.id === "independent-operators")?.passed).toBe(true);
    });

    it("same operator behind two hostnames is ONE witness → MANUAL_REVIEW_REQUIRED", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          providers: [
            P({ provider: "fastnear", operator: "fastnear", accessKeyNonce: 11n }),
            P({ provider: "fastnear-archival", operator: "fastnear", accessKeyNonce: 11n }),
          ],
        }),
      );
      expect(r.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    });

    it("nonce consumed but only 1 operator holds the window → MANUAL_REVIEW_REQUIRED", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 11n }),
            P({ provider: "b", operator: "y", accessKeyNonce: 11n, coversWindow: false }),
          ],
        }),
      );
      expect(r.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    });

    it("unknown window coverage (null) never counts as proof", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 11n, coversWindow: null }),
            P({ provider: "b", operator: "y", accessKeyNonce: 11n, coversWindow: null }),
          ],
        }),
      );
      expect(r.verdict).not.toBe("SAFE_TO_RETRY");
    });

    it("access key missing is NOT proof (key could be re-added) → MANUAL_REVIEW_REQUIRED", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          providers: [P({ provider: "a", operator: "x", accessKeyMissing: true }), P({ provider: "b", operator: "y", accessKeyMissing: true })],
        }),
      );
      expect(r.verdict).toBe("MANUAL_REVIEW_REQUIRED");
    });

    it("expired (final height − tx block height > validity) on 2 operators → SAFE_TO_RETRY", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          txBlockHeight: 1000,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 3n, txBlockHeight: 1000, observedFinalHeight: 1000 + 86_401 }),
            P({ provider: "b", operator: "y", accessKeyNonce: 3n, txBlockHeight: 1000, observedFinalHeight: 1000 + 86_500 }),
          ],
        }),
      );
      expect(r.verdict).toBe("SAFE_TO_RETRY");
    });

    it("exactly at the validity boundary is NOT expired", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          txBlockHeight: 1000,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 3n, txBlockHeight: 1000, observedFinalHeight: 1000 + 86_400 }),
            P({ provider: "b", operator: "y", accessKeyNonce: 3n, txBlockHeight: 1000, observedFinalHeight: 1000 + 86_400 }),
          ],
        }),
      );
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
    });

    it("nonce unused and not expired → WAIT_AND_RECHECK with ETA and same-tx rebroadcast advice", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          txBlockHeight: 1000,
          blockTimeSeconds: 0.6,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 9n, txBlockHeight: 1000, observedFinalHeight: 2000 }),
            P({ provider: "b", operator: "y", accessKeyNonce: 9n, txBlockHeight: 1000, observedFinalHeight: 2000 }),
          ],
        }),
      );
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
      expect(r.confidence).toBe("high");
      expect(r.rebroadcastSameSignedTxIsSafe).toBe(true);
      expect(r.reason).toContain("85400 more blocks");
      expect(r.reason).toContain("854 min");
      expect(r.nextAction).toMatch(/IDENTICAL/);
    });

    it("no ETA minutes are invented when block time is unknown", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          txBlockHeight: 1000,
          providers: [P({ provider: "a", operator: "x", accessKeyNonce: 9n, txBlockHeight: 1000, observedFinalHeight: 2000 })],
        }),
      );
      expect(r.reason).toContain("85400 more blocks");
      expect(r.reason).not.toMatch(/min/);
    });

    it("caller-supplied fields (not decoded from the signed tx) never yield SAFE_TO_RETRY", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          fieldsFromSignedTx: false,
          providers: [P({ provider: "a", operator: "x", accessKeyNonce: 11n }), P({ provider: "b", operator: "y", accessKeyNonce: 11n })],
        }),
      );
      expect(r.verdict).toBe("MANUAL_REVIEW_REQUIRED");
      expect(r.checks.find((c) => c.id === "fields-bound-to-hash")?.passed).toBe(false);
    });

    it("expiry uses each provider's own tx-block height: a provider without it cannot prove expiry", () => {
      const r = decideRetry(
        base({
          txNonce: 10n,
          txBlockHeight: 1, // a single (possibly wrong) global height must not be used for proofs
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 3n, observedFinalHeight: 2000 }),
            P({ provider: "b", operator: "y", accessKeyNonce: 3n, observedFinalHeight: 2000 }),
          ],
        }),
      );
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
    });

    it("nonce never read from any provider → WAIT_AND_RECHECK low, does not claim the nonce is unused", () => {
      const r = decideRetry(base({ txNonce: 10n, providers: [P({ provider: "a", operator: "x" }), P({ provider: "b", operator: "y" })] }));
      expect(r.verdict).toBe("WAIT_AND_RECHECK");
      expect(r.confidence).toBe("low");
      expect(r.reason).not.toMatch(/nonce is unused/);
    });

    it("minIndependentOperators=1 lets one covering operator prove it", () => {
      const r = decideRetry(base({ txNonce: 10n, minIndependentOperators: 1, providers: [P({ provider: "a", operator: "x", accessKeyNonce: 10n })] }));
      expect(r.verdict).toBe("SAFE_TO_RETRY");
    });

    it("a provider that FOUND it in the second lookup blocks SAFE even if nonce consumed elsewhere", () => {
      // Without `found`, an inconsistent provider list must still not yield SAFE from a FOUND provider.
      const r = decideRetry(
        base({
          txNonce: 10n,
          providers: [
            P({ provider: "a", operator: "x", accessKeyNonce: 11n, txLookup: "FOUND" }),
            P({ provider: "b", operator: "y", accessKeyNonce: 11n }),
          ],
        }),
      );
      expect(r.verdict).not.toBe("SAFE_TO_RETRY");
    });
  });
});
