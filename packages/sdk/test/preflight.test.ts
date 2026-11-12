import { afterEach, describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { SentinelInputError } from "../src/errors.js";
import { INTENT_ID_RE, intentIdPrivacyWarning, privateIntentId } from "../src/intent.js";
import { assessAllowanceSafety, decideSpendPreflight, PREFLIGHT_ADVISORY, type AllowanceCheck, type VaultPolicy } from "../src/vault.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";
import type { ProviderConfig } from "../src/types.js";

const NEAR = 10n ** 24n;
const FEE = 6n * 10n ** 21n;
const vault = { contractId: "vault.alice.testnet", ownerId: "alice.testnet", agentId: "agent.alice.testnet" };
const FUTURE = Date.now() + 3_600_000;
const policy = (over: Partial<VaultPolicy> = {}): VaultPolicy => ({
  owner_id: vault.ownerId,
  agent_id: vault.agentId,
  balance: String(3n * NEAR),
  per_payment_max: String(NEAR),
  daily_max: String((3n * NEAR) / 2n),
  spent_in_window: String(NEAR / 2n),
  available_now: String(NEAR),
  window_resets_at_ms: FUTURE,
  allowed_receivers: ["shop.testnet"],
  frozen: false,
  ...over,
});
const view = (value: unknown, height = 5000): MockAnswer => ({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: height, block_hash: "x" } });
const spendRecord = { receiver_id: "shop.testnet", amount: String(NEAR), block_height: 4000, status: "Paid" };

const servers: RunningServer[] = [];
const seen: any[] = [];
/** One mock provider: answers get_policy with `pol` and get_spend with `spend`. */
async function provider(name: string, pol: MockAnswer, spend: MockAnswer = view(null)): Promise<ProviderConfig> {
  const srv = await startMockRpc((method, params) => {
    seen.push({ name, method, params });
    return params?.method_name === "get_spend" ? spend : pol;
  });
  servers.push(srv);
  return { name, url: srv.url, operator: name };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  seen.length = 0;
});
const S = (p: ProviderConfig[]) => new NearSentinel({ rpcProviders: p, timeoutMs: 1500 });
const req = (over: Record<string, unknown> = {}) => ({ ...vault, receiverId: "shop.testnet", amountYocto: String(NEAR / 2n), ...over });

describe("preflightSpend (advisory mirror of Vault spend())", () => {
  it("ALLOWED: cost includes the 0.006 NEAR fee; get_spend is asked with owner/agent/intent", async () => {
    const r = await S([await provider("a", view(policy()))]).preflightSpend(req({ intentId: "order-1" }));
    expect(r.decision).toBe("ALLOWED");
    expect(r.code).toBeUndefined();
    expect(r.amount).toBe(String(NEAR / 2n));
    expect(r.costYocto).toBe(String(NEAR / 2n + FEE));
    expect(r.duplicate).toBe(false);
    expect(r.intentId).toBe("order-1");
    expect(r.advisory).toBe(PREFLIGHT_ADVISORY);
    expect(r.allowance.status).toBe("ACTIVE");
    const q = seen.find((s) => s.params.method_name === "get_spend").params;
    expect(JSON.parse(Buffer.from(q.args_base64, "base64").toString())).toEqual({ owner_id: vault.ownerId, agent_id: vault.agentId, intent_id: "order-1" });
  });

  it("no intentId: get_spend is not called", async () => {
    const r = await S([await provider("a", view(policy()))]).preflightSpend(req());
    expect(r.decision).toBe("ALLOWED");
    expect(r.duplicate).toBeUndefined();
    expect(seen.some((s) => s.params.method_name === "get_spend")).toBe(false);
  });

  // Each case breaks exactly one rule AND every later one, proving the contract's check order.
  const cases: Array<[string, Record<string, unknown>, Partial<VaultPolicy> | null, MockAnswer?]> = [
    ["INVALID_AMOUNT", { amountYocto: "0", receiverId: vault.contractId, intentId: "dup" }, null, view(spendRecord)],
    ["INVALID_RECEIVER", { receiverId: vault.contractId, intentId: "dup" }, null, view(spendRecord)],
    ["DUPLICATE_INTENT", { intentId: "dup", receiverId: "evil.testnet" }, null, view(spendRecord)],
    ["NO_POLICY", { receiverId: "evil.testnet" }, null],
    ["FROZEN", { receiverId: "evil.testnet", amountYocto: String(10n * NEAR) }, { frozen: true, available_now: "0" }],
    ["NOT_ALLOWED_RECEIVER", { receiverId: "evil.testnet", amountYocto: String(10n * NEAR) }, {}],
    ["OVER_PER_PAYMENT_LIMIT", { amountYocto: String(10n * NEAR) }, {}],
    ["OVER_DAILY_LIMIT", { amountYocto: String(NEAR) }, { balance: String(NEAR / 2n) }], // spent_in_window set to 1 below: 0.5 left
    ["INSUFFICIENT_VAULT_BALANCE", { amountYocto: String(NEAR / 2n) }, { balance: String(NEAR / 2n) }],
  ];
  for (const [code, over, pol, spend] of cases) {
    it(`BLOCKED ${code}`, async () => {
      const p = code === "OVER_DAILY_LIMIT" ? { ...pol, spent_in_window: String(NEAR) } : pol;
      const r = await S([await provider("a", view(p === null ? null : policy(p)), spend)]).preflightSpend(req(over));
      expect(r.decision).toBe("BLOCKED");
      expect(r.code).toBe(code);
      expect(r.reason).toContain(code);
      expect(r.advisory).toBe(PREFLIGHT_ADVISORY);
    });
  }

  it("OVER_DAILY_LIMIT uses the full daily_max once the window reset time has passed", () => {
    const allowance = { ...vault, status: "ACTIVE", availableNow: String(NEAR), reason: "", checkedAt: "", policy: policy(), providers: [] } as AllowanceCheck;
    const p = policy({ spent_in_window: String((3n * NEAR) / 2n), window_resets_at_ms: 1000 });
    const a = { ...allowance, policy: p, providers: [{ provider: "a", operator: "a", answer: "POLICY" as const, policy: p, latencyMs: 1 }] };
    expect(decideSpendPreflight(a, { receiverId: "shop.testnet", amount: String(NEAR) }).decision).toBe("ALLOWED");
    const fresh = { ...a, providers: [{ ...a.providers[0]!, policy: { ...p, window_resets_at_ms: FUTURE } }] };
    expect(decideSpendPreflight(fresh, { receiverId: "shop.testnet", amount: String(NEAR) }).code).toBe("OVER_DAILY_LIMIT");
  });

  it("never ALLOWED above the smallest available_now any provider reports", async () => {
    const r = await S([
      await provider("fresh", view(policy(), 6000)),
      await provider("lagging", view(policy({ available_now: String(NEAR / 10n) }), 5000)),
    ]).preflightSpend(req());
    expect(r.allowance.availableNow).toBe(String(NEAR / 10n));
    expect(r.decision).toBe("UNKNOWN");
  });

  it("provider split: a stricter provider's policy blocks (conservative)", async () => {
    const r = await S([
      await provider("fresh", view(policy(), 6000)),
      await provider("lagging", view(policy({ per_payment_max: String(NEAR / 4n) }), 5000)),
    ]).preflightSpend(req());
    expect(r.decision).toBe("BLOCKED");
    expect(r.code).toBe("OVER_PER_PAYMENT_LIMIT");
  });

  it("duplicate if ANY provider has a spend record", async () => {
    const r = await S([await provider("a", view(policy())), await provider("b", view(policy()), view(spendRecord))]).preflightSpend(req({ intentId: "order-1" }));
    expect(r.code).toBe("DUPLICATE_INTENT");
    expect(r.duplicate).toBe(true);
  });

  it("one 'not used' answer while another provider errors is not enough: UNKNOWN, never ALLOWED", async () => {
    const r = await S([await provider("a", view(policy())), await provider("b", view(policy()), { fault: { type: "http-502" } })]).preflightSpend(req({ intentId: "order-1" }));
    expect(r.duplicate).toBeUndefined();
    expect(r.decision).toBe("UNKNOWN");
  });

  it("the pure decision validates its own inputs like the contract (intent id first, then the receiver)", () => {
    const allowance = { ...vault, status: "ACTIVE", availableNow: String(NEAR), reason: "", checkedAt: "", policy: policy(), providers: [{ provider: "a", operator: "a", answer: "POLICY" as const, policy: policy(), latencyMs: 1 }] } as AllowanceCheck;
    expect(decideSpendPreflight(allowance, { receiverId: "shop.testnet", amount: String(NEAR), intentId: "has space" }).code).toBe("INVALID_INTENT_ID");
    expect(decideSpendPreflight(allowance, { receiverId: "Not A Valid Account", amount: String(NEAR) }).code).toBe("INVALID_RECEIVER");
  });

  it("UNKNOWN when no provider answers (502)", async () => {
    const r = await S([await provider("a", { fault: { type: "http-502" } }, { fault: { type: "http-502" } })]).preflightSpend(req({ intentId: "order-1" }));
    expect(r.decision).toBe("UNKNOWN");
    expect(r.code).toBeUndefined();
    expect(r.allowance.status).toBe("UNKNOWN");
    expect(r.duplicate).toBeUndefined();
  });

  it("UNKNOWN when the limits pass but get_spend could not be read", async () => {
    const r = await S([await provider("a", view(policy()), { fault: { type: "http-502" } })]).preflightSpend(req({ intentId: "order-1" }));
    expect(r.decision).toBe("UNKNOWN");
    expect(r.reason).toMatch(/already used/);
  });

  it("rejects bad input before any network call (non-digit amount, bad receiver, bad intent)", async () => {
    const s = S([await provider("a", view(policy()))]);
    await expect(s.preflightSpend(req({ amountYocto: "1.5" }))).rejects.toBeInstanceOf(SentinelInputError);
    await expect(s.preflightSpend(req({ amountYocto: "-1" }))).rejects.toBeInstanceOf(SentinelInputError);
    await expect(s.preflightSpend(req({ receiverId: "Not Valid" }))).rejects.toBeInstanceOf(SentinelInputError);
    await expect(s.preflightSpend(req({ intentId: "has space" }))).rejects.toBeInstanceOf(SentinelInputError);
    expect(seen).toHaveLength(0);
  });
});

describe("assessAllowanceSafety", () => {
  it("a tight policy is strong with no findings", () => {
    expect(assessAllowanceSafety(policy())).toEqual({ score: 100, grade: "strong", findings: [] });
  });
  it("any receiver allowed is high", () => {
    const s = assessAllowanceSafety(policy({ allowed_receivers: [] }));
    expect(s.findings[0]).toMatchObject({ severity: "high", title: expect.stringMatching(/Any receiver allowed/) });
    expect(s.findings[0]!.fix).toBeTruthy();
    expect(s.score).toBe(65);
    expect(s.grade).toBe("fair");
  });
  it("agent on its own receiver list is high", () => {
    const s = assessAllowanceSafety(policy({ allowed_receivers: [vault.agentId] }));
    expect(s.findings.map((f) => f.severity)).toEqual(["high"]);
  });
  it("per-payment = daily and daily >= balance are medium; everything bad is weak, floored at 0", () => {
    const s = assessAllowanceSafety(policy({ per_payment_max: String(NEAR), daily_max: String(NEAR), balance: String(NEAR) }));
    expect(s.findings.map((f) => f.severity)).toEqual(["medium", "medium"]);
    expect(s.score).toBe(70);
    const worst = assessAllowanceSafety(policy({ allowed_receivers: [vault.agentId, "x.testnet"], per_payment_max: String(NEAR), daily_max: String(NEAR), balance: String(NEAR) }));
    expect(worst.grade).toBe("weak");
    expect(assessAllowanceSafety(policy({ allowed_receivers: [], per_payment_max: "1", daily_max: "1", balance: "1" })).score).toBe(35);
  });
  it("zero balance does not trigger the balance rule; frozen is info only", () => {
    const s = assessAllowanceSafety(policy({ balance: "0", frozen: true }));
    expect(s.findings).toEqual([{ severity: "info", title: expect.stringMatching(/paused/) }]);
    expect(s.score).toBe(100);
  });
  it("checkSpendAllowance adds safety when a policy exists, not otherwise", async () => {
    const a = await S([await provider("a", view(policy({ allowed_receivers: [] })))]).checkSpendAllowance(vault);
    expect(a.safety?.grade).toBe("fair");
    const b = await S([await provider("b", view(null))]).checkSpendAllowance(vault);
    expect(b.safety).toBeUndefined();
  });
});

describe("private intent IDs", () => {
  const secret = "0123456789abcdef-secret";
  it("privateIntentId is stable, prefixed, 42 chars and valid for the contracts", () => {
    const a = privateIntentId(secret, "invoice 2026/0042 for bob@example.com");
    expect(a).toBe(privateIntentId(secret, "invoice 2026/0042 for bob@example.com"));
    expect(a).toMatch(/^p:[0-9a-f]{40}$/);
    expect(INTENT_ID_RE.test(a)).toBe(true);
    expect(privateIntentId(secret, "other")).not.toBe(a);
    expect(privateIntentId(secret + "x", "invoice 2026/0042 for bob@example.com")).not.toBe(a);
    expect(intentIdPrivacyWarning(a)).toBeNull();
  });
  it("privateIntentId rejects a short secret", () => {
    expect(() => privateIntentId("short", "x")).toThrow(SentinelInputError);
  });
  it("intentIdPrivacyWarning flags emails, phone numbers and long digit runs", () => {
    expect(intentIdPrivacyWarning("bob@example.com")).toMatch(/email/);
    expect(intentIdPrivacyWarning("call-+14155550123")).toMatch(/phone/);
    expect(intentIdPrivacyWarning("tel:415-555-0123")).toMatch(/phone/);
    expect(intentIdPrivacyWarning("card-4111111111111111")).toMatch(/long number/);
    expect(intentIdPrivacyWarning("order-42")).toBeNull();
    expect(intentIdPrivacyWarning("2026-11-12:run-7")).toBeNull();
  });
});
