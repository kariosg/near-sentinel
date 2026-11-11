import { describe, expect, it } from "vitest";
import { diagnoseObservations, diagnoseSubmissionError, timeoutCause } from "../src/diagnostics.js";
import type { RpcObservation } from "../src/types.js";

/** Real error bodies captured from testnet on 2026-11-09. */
const REAL_TIMEOUT = {
  name: "HANDLER_ERROR",
  cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" },
  code: -32000,
  message: "Server error",
  data: "Timeout",
};
const REAL_DRPC_TIMEOUT = { message: "Request timeout on the free plan, please upgrade to paid plan", code: 30 };

describe("diagnoseSubmissionError", () => {
  it("real nearcore TIMEOUT_ERROR → RPC_TIMEOUT, retry unknown, cause surfaced", () => {
    const d = diagnoseSubmissionError(REAL_TIMEOUT);
    expect(d.code).toBe("RPC_TIMEOUT");
    expect(d.retry).toBe("unknown");
    expect(d.title).toContain("NOT_OBSERVED");
    expect(d.suggestedAction).toMatch(/Do NOT sign a new transaction/);
    expect(d.evidence.some((e) => e.claim.includes("cause=NOT_OBSERVED"))).toBe(true);
  });

  it("PENDING cause says it is very likely to execute", () => {
    const d = diagnoseSubmissionError({ ...REAL_TIMEOUT, cause: { info: { cause: "PENDING" }, name: "TIMEOUT_ERROR" } });
    expect(d.explanation).toMatch(/SEEN the transaction/);
  });

  it("dRPC free-plan timeout text → RPC_TIMEOUT", () => {
    expect(diagnoseSubmissionError(REAL_DRPC_TIMEOUT).code).toBe("RPC_TIMEOUT");
  });

  it("near-api-js style error strings", () => {
    expect(diagnoseSubmissionError("TypedError: Transaction has timed out").code).toBe("RPC_TIMEOUT");
    expect(diagnoseSubmissionError(new Error("fetch failed: ECONNRESET")).code).toBe("NETWORK_UNAVAILABLE");
  });

  it("InvalidNonce (nearcore shape) → INVALID_NONCE with retry unknown (classic double-send symptom)", () => {
    const d = diagnoseSubmissionError({
      name: "HANDLER_ERROR",
      cause: { name: "INVALID_TRANSACTION", info: {} },
      data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 7 } } } },
    });
    expect(d.code).toBe("INVALID_NONCE");
    expect(d.retry).toBe("unknown");
    expect(d.confidence).toBe("high");
    expect(d.evidence[1]?.excerpt).toEqual({ tx_nonce: 5, ak_nonce: 7 });
  });

  it.each([
    ["NotEnoughBalance", "INSUFFICIENT_BALANCE", "safe"],
    ["Expired", "TRANSACTION_EXPIRED", "safe"],
    ["ShardCongested", "SUBMISSION_REJECTED", "safe"],
    ["InvalidSignature", "INVALID_TRANSACTION", "safe"],
  ])("%s → %s (retry %s)", (key, code, retry) => {
    const d = diagnoseSubmissionError({ data: { TxExecutionError: { InvalidTxError: { [key]: {} } } } });
    expect(d.code).toBe(code);
    expect(d.retry).toBe(retry);
  });

  it("an execution failure means the tx WAS included", () => {
    const d = diagnoseSubmissionError({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "panic" } } } });
    expect(d.code).toBe("CONTRACT_EXECUTION_FAILURE");
    expect(d.explanation).toMatch(/WAS included/);
  });

  it("garbage → UNKNOWN_FAILURE with low confidence, never 'safe'", () => {
    const d = diagnoseSubmissionError({ weird: true });
    expect(d.code).toBe("UNKNOWN_FAILURE");
    expect(d.confidence).toBe("low");
    expect(d.retry).toBe("unknown");
  });

  it("numbers that merely contain 408 are not mistaken for timeouts", () => {
    expect(diagnoseSubmissionError({ data: { nonce: 14082 }, message: "something odd" }).code).toBe("UNKNOWN_FAILURE");
  });
});

describe("timeoutCause", () => {
  it("reads raw and normalised shapes", () => {
    expect(timeoutCause(REAL_TIMEOUT)).toBe("NOT_OBSERVED");
    expect(timeoutCause({ kind: "TIMEOUT", causeName: "TIMEOUT_ERROR", causeInfo: { cause: "PENDING" } })).toBe("PENDING");
    expect(timeoutCause({})).toBeUndefined();
  });
});

describe("diagnoseObservations", () => {
  const obs = (over: Partial<RpcObservation>): RpcObservation => ({
    provider: "p",
    operator: "o",
    url: "u",
    method: "EXPERIMENTAL_tx_status",
    params: {},
    ok: false,
    latencyMs: 10,
    observedAt: "t",
    ...over,
  });
  it("groups each failure class and cites observation indexes", () => {
    const d = diagnoseObservations([
      obs({ error: { kind: "TIMEOUT", causeName: "TIMEOUT_ERROR", causeInfo: { cause: "NOT_OBSERVED" }, message: "t" } }),
      obs({ error: { kind: "RATE_LIMITED", message: "r" }, httpStatus: 429 }),
      obs({ error: { kind: "NETWORK", message: "n" } }),
      obs({ error: { kind: "MALFORMED", message: "m" } }),
      obs({ ok: true }),
    ]);
    expect(d.map((x) => x.code)).toEqual(["RPC_TIMEOUT", "RATE_LIMITED", "NETWORK_UNAVAILABLE", "MALFORMED_RESPONSE"]);
    expect(d[0]!.evidence[0]!.observationIndex).toBe(0);
    expect(d[0]!.evidence[0]!.claim).toContain("NOT_OBSERVED");
    expect(d.every((x) => x.retry === "unknown")).toBe(true);
  });
});
