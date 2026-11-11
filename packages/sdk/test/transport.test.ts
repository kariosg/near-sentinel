import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMethodNotFound, isTimeout, isUnknownTx, rpcCall } from "../src/rpc.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";

/** One mock server; the JSON-RPC method name selects the scripted behaviour. */
const script: Record<string, MockAnswer> = {
  ok: { result: { hello: "world" } },
  hang: { fault: { type: "hang" } },
  drpc408: { error: { message: "Request timeout on the free plan, please upgrade to paid plan", code: 30 }, httpStatus: 408 },
  // Real nearcore shape captured live 2026-11-09 (FastNEAR testnet, 10.28 s):
  nearcoreTimeout: {
    error: { name: "HANDLER_ERROR", cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error", data: "Timeout" },
    httpStatus: 408,
  },
  rate: { fault: { type: "rate-limit" } },
  reset: { fault: { type: "reset" } },
  malformed: { fault: { type: "malformed" } },
  big: { fault: { type: "oversized", bytes: 50_000 } },
  bad502: { fault: { type: "http-502" } },
  // Real Lava response captured live 2026-11-09 (HTTP 410):
  discontinued: { error: "This endpoint has been discontinued.", httpStatus: 410 },
  unknownTx: {
    error: { name: "HANDLER_ERROR", cause: { info: { requested_transaction_hash: "1" }, name: "UNKNOWN_TRANSACTION" }, code: -32000, message: "Server error" },
  },
  // Real dRPC response for tx_status captured live 2026-11-09 (HTTP 400):
  noMethod: { error: { message: "method is not available", code: -32601 }, httpStatus: 400 },
  slow: { result: 1, delayMs: 400 },
  nullResult: { result: null },
};

let mock: RunningServer;
const provider = () => ({ name: "mock", url: mock.url, operator: "test" });
const opts = { timeoutMs: 250, maxResponseBytes: 10_000 };

beforeAll(async () => {
  mock = await startMockRpc((method) => script[method] ?? { result: "unscripted" });
});
afterAll(() => mock.close());

describe("rpcCall: one call, one observation, never throws", () => {
  it("ok result", async () => {
    const o = await rpcCall(provider(), "ok", {}, opts);
    expect(o.ok).toBe(true);
    expect(o.result).toEqual({ hello: "world" });
    expect(o.httpStatus).toBe(200);
    expect(o.operator).toBe("test");
    expect(o.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("client deadline → TIMEOUT", async () => {
    const o = await rpcCall(provider(), "hang", {}, opts);
    expect(o.ok).toBe(false);
    expect(o.error?.kind).toBe("TIMEOUT");
    expect(isTimeout(o)).toBe(true);
    expect(o.latencyMs).toBeGreaterThanOrEqual(240);
  });

  it("dRPC free-plan HTTP 408 code 30 → TIMEOUT (not a tx failure)", async () => {
    const o = await rpcCall(provider(), "drpc408", {}, opts);
    expect(o.error?.kind).toBe("TIMEOUT");
    expect(o.error?.code).toBe(30);
    expect(isTimeout(o)).toBe(true);
  });

  it("nearcore TIMEOUT_ERROR keeps the cause NOT_OBSERVED", async () => {
    const o = await rpcCall(provider(), "nearcoreTimeout", {}, opts);
    expect(isTimeout(o)).toBe(true);
    expect(o.error?.causeName).toBe("TIMEOUT_ERROR");
    expect(o.error?.causeInfo).toEqual({ cause: "NOT_OBSERVED" });
  });

  it("rate limit → RATE_LIMITED", async () => {
    const o = await rpcCall(provider(), "rate", {}, opts);
    expect(o.error?.kind).toBe("RATE_LIMITED");
    expect(o.httpStatus).toBe(429);
  });

  it("connection reset → NETWORK", async () => {
    const o = await rpcCall(provider(), "reset", {}, opts);
    expect(o.error?.kind).toBe("NETWORK");
  });

  it("malformed JSON → MALFORMED", async () => {
    const o = await rpcCall(provider(), "malformed", {}, opts);
    expect(o.error?.kind).toBe("MALFORMED");
  });

  it("oversized body is cut off at maxResponseBytes → TOO_LARGE", async () => {
    const o = await rpcCall(provider(), "big", {}, opts);
    expect(o.error?.kind).toBe("TOO_LARGE");
  });

  it("HTML 502 → HTTP_ERROR", async () => {
    const o = await rpcCall(provider(), "bad502", {}, opts);
    expect(o.error?.kind).toBe("HTTP_ERROR");
    expect(o.httpStatus).toBe(502);
  });

  it("non-JSON-RPC error envelope (discontinued endpoint) → HTTP_ERROR with message", async () => {
    const o = await rpcCall(provider(), "discontinued", {}, opts);
    expect(o.error?.kind).toBe("HTTP_ERROR");
    expect(o.error?.message).toContain("discontinued");
  });

  it("UNKNOWN_TRANSACTION is an RPC_ERROR answer, recognised by isUnknownTx", async () => {
    const o = await rpcCall(provider(), "unknownTx", {}, opts);
    expect(o.error?.kind).toBe("RPC_ERROR");
    expect(isUnknownTx(o)).toBe(true);
  });

  it("-32601 is recognised as method-not-found", async () => {
    const o = await rpcCall(provider(), "noMethod", {}, opts);
    expect(isMethodNotFound(o)).toBe(true);
  });

  it("result:null is a valid answer (not malformed)", async () => {
    const o = await rpcCall(provider(), "nullResult", {}, opts);
    expect(o.ok).toBe(true);
    expect(o.result).toBeNull();
  });

  it("caller abort → ABORTED (distinct from TIMEOUT)", async () => {
    const ctrl = new AbortController();
    const p = rpcCall(provider(), "slow", {}, { ...opts, timeoutMs: 5000, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const o = await p;
    expect(o.error?.kind).toBe("ABORTED");
  });

  it("unreachable host → NETWORK", async () => {
    const o = await rpcCall({ name: "dead", url: "http://127.0.0.1:1" }, "ok", {}, opts);
    expect(o.error?.kind).toBe("NETWORK");
  });
});
