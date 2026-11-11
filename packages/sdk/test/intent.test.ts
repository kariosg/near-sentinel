import { afterEach, describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { SentinelInputError } from "../src/errors.js";
import { decideIntent, decodeViewResult, type IntentProviderAnswer } from "../src/intent.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";
import type { ProviderConfig } from "../src/types.js";

const input = { contractId: "guard.alice.testnet", payerId: "agent.alice.testnet", intentId: "order-42" };
const record = (over: Record<string, unknown> = {}) => ({
  payer_id: input.payerId,
  intent_id: input.intentId,
  receiver_id: "merchant.testnet",
  amount: "995000000000000000000000",
  block_height: 1234,
  status: "Paid",
  ...over,
});
const view = (value: unknown): MockAnswer => ({
  result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 5000, block_hash: "x" },
});
const NO_CONTRACT: MockAnswer = {
  error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "NO_CONTRACT_CODE", info: {} } },
};

const servers: RunningServer[] = [];
const seen: any[] = [];
async function provider(name: string, answer: MockAnswer): Promise<ProviderConfig> {
  const srv = await startMockRpc((method, params) => {
    seen.push({ name, method, params });
    return method === "query" ? answer : { error: { name: "x", code: -1, message: "unexpected" } };
  });
  servers.push(srv);
  return { name, url: srv.url, operator: name.split("-")[0] };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  seen.length = 0;
});
const S = (p: ProviderConfig[]) => new NearSentinel({ rpcProviders: p, timeoutMs: 1500 });

describe("checkIntent (guard contract, read-only)", () => {
  it("sends a get_intent view call with base64 JSON args at finality=final", async () => {
    const s = S([await provider("a", view(null))]);
    await s.checkIntent(input);
    const q = seen.find((x) => x.method === "query")!.params;
    expect(q).toMatchObject({ request_type: "call_function", finality: "final", account_id: input.contractId, method_name: "get_intent" });
    expect(JSON.parse(Buffer.from(q.args_base64, "base64").toString())).toEqual({ payer_id: input.payerId, intent_id: input.intentId });
  });

  it("PAID when a provider returns the record; resending the same intent is still safe", async () => {
    const r = await S([await provider("a", view(record())), await provider("b", view(record()))]).checkIntent(input);
    expect(r.status).toBe("PAID");
    expect(r.intent?.receiver_id).toBe("merchant.testnet");
    expect(r.resendSameIntentIsSafe).toBe(true);
    expect(r.reason).toMatch(/Do NOT pay again/);
  });

  it("a lagging node showing Pending does not hide Paid from another", async () => {
    const r = await S([await provider("a", view(record({ status: "Pending" }))), await provider("b", view(record()))]).checkIntent(input);
    expect(r.status).toBe("PAID");
  });

  it("positive evidence wins over a node without the record", async () => {
    const r = await S([await provider("a", view(null)), await provider("b", view(record({ status: "Pending" })))]).checkIntent(input);
    expect(r.status).toBe("PENDING");
  });

  it("NOT_RECORDED explains that a same-intent resend is rejected on-chain if the first lands", async () => {
    const r = await S([await provider("a", view(null)), await provider("b", view(null))]).checkIntent(input);
    expect(r.status).toBe("NOT_RECORDED");
    expect(r.reason).toMatch(/DUPLICATE_INTENT/);
  });

  it("different records across providers → CONFLICTING", async () => {
    const r = await S([await provider("a", view(record())), await provider("b", view(record({ receiver_id: "evil.testnet" })))]).checkIntent(input);
    expect(r.status).toBe("CONFLICTING");
  });

  it("a record for ANOTHER payer or intent is rejected as an error, not trusted", async () => {
    const r = await S([await provider("a", view(record({ payer_id: "someone-else.testnet" }))), await provider("b", view(record({ intent_id: "other" })))]).checkIntent(input);
    expect(r.status).toBe("UNKNOWN");
    expect(r.providers.every((p) => p.answer === "ERROR")).toBe(true);
  });

  it("missing contract / transport failure → UNKNOWN, never NOT_RECORDED", async () => {
    const r = await S([await provider("a", NO_CONTRACT), await provider("b", { fault: { type: "http-502" } })]).checkIntent(input);
    expect(r.status).toBe("UNKNOWN");
  });

  it.each([
    [{ ...input, intentId: "" }],
    [{ ...input, intentId: "x".repeat(65) }],
    [{ ...input, intentId: 'a"b' }],
    [{ ...input, contractId: "NOT VALID" }],
    [{ ...input, extra: 1 }],
  ])("rejects bad input %#", async (bad) => {
    await expect(S([await provider("a", view(null))]).checkIntent(bad as any)).rejects.toBeInstanceOf(SentinelInputError);
  });
});

describe("decodeViewResult / decideIntent", () => {
  it("handles legacy result.error, malformed bytes and non-JSON", () => {
    expect(decodeViewResult({ ok: true, result: { error: "wasm execution failed" } } as any)).toEqual({ kind: "error", message: "wasm execution failed" });
    expect(decodeViewResult({ ok: true, result: { result: "nope" } } as any).kind).toBe("error");
    expect(decodeViewResult({ ok: true, result: { result: [...Buffer.from("{not json")] } } as any).kind).toBe("error");
    expect(decodeViewResult({ ok: true, result: { result: [0xff, 0xfe] } } as any).kind).toBe("error");
  });

  it("no answers at all → UNKNOWN", () => {
    const answers: IntentProviderAnswer[] = [{ provider: "a", operator: "a", answer: "ERROR", latencyMs: 1 }];
    expect(decideIntent(input, answers).status).toBe("UNKNOWN");
  });
});
