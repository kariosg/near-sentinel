import { afterEach, describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { SentinelInputError } from "../src/errors.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";
import type { ProviderConfig } from "../src/types.js";

const input = { contractId: "vault.alice.testnet", ownerId: "alice.testnet", agentId: "agent.alice.testnet" };
const NEAR = 10n ** 24n;
const policy = (over: Record<string, unknown> = {}) => ({
  owner_id: input.ownerId,
  agent_id: input.agentId,
  balance: String(3n * NEAR),
  per_payment_max: String(NEAR),
  daily_max: String((3n * NEAR) / 2n),
  spent_in_window: String(NEAR / 2n),
  available_now: String(NEAR),
  window_resets_at_ms: 1_800_000_000_000,
  allowed_receivers: ["shop.testnet"],
  frozen: false,
  ...over,
});
const view = (value: unknown, height = 5000): MockAnswer => ({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: height, block_hash: "x" } });

const servers: RunningServer[] = [];
const seen: any[] = [];
async function provider(name: string, answer: MockAnswer): Promise<ProviderConfig> {
  const srv = await startMockRpc((method, params) => {
    seen.push({ name, method, params });
    return answer;
  });
  servers.push(srv);
  return { name, url: srv.url, operator: name };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  seen.length = 0;
});
const S = (p: ProviderConfig[]) => new NearSentinel({ rpcProviders: p, timeoutMs: 1500 });

describe("checkSpendAllowance (Sentinel Vault, read-only)", () => {
  it("sends a get_policy view call at finality=final", async () => {
    await S([await provider("a", view(null))]).checkSpendAllowance(input);
    const q = seen[0].params;
    expect(q).toMatchObject({ request_type: "call_function", finality: "final", account_id: input.contractId, method_name: "get_policy" });
    expect(JSON.parse(Buffer.from(q.args_base64, "base64").toString())).toEqual({ owner_id: input.ownerId, agent_id: input.agentId });
  });

  it("ACTIVE: reports the limits and how much can be spent now", async () => {
    const r = await S([await provider("a", view(policy())), await provider("b", view(policy()))]).checkSpendAllowance(input);
    expect(r.status).toBe("ACTIVE");
    expect(r.availableNow).toBe(String(NEAR));
    expect(r.reason).toMatch(/Up to 1 NEAR/);
    expect(r.reason).toMatch(/only to shop\.testnet/);
  });

  it("never overstates: a lagging provider showing more available does not win", async () => {
    const r = await S([
      await provider("fresh", view(policy({ available_now: String(NEAR / 10n) }), 6000)),
      await provider("lagging", view(policy({ available_now: String(NEAR) }), 5000)),
    ]).checkSpendAllowance(input);
    expect(r.availableNow).toBe(String(NEAR / 10n));
    expect(r.policy?.available_now).toBe(String(NEAR / 10n)); // the freshest policy is reported
  });

  it("FROZEN wins over any provider that still shows the agent active", async () => {
    const r = await S([await provider("a", view(policy({ frozen: true, available_now: "0" }))), await provider("b", view(policy()))]).checkSpendAllowance(input);
    expect(r.status).toBe("FROZEN");
    expect(r.availableNow).toBe("0");
  });

  it("EXHAUSTED when nothing can be spent now", async () => {
    const r = await S([await provider("a", view(policy({ available_now: "0" })))]).checkSpendAllowance(input);
    expect(r.status).toBe("EXHAUSTED");
    expect(r.reason).toMatch(/resets at/);
  });

  it("NO_POLICY when the vault has nothing for this owner and agent", async () => {
    const r = await S([await provider("a", view(null))]).checkSpendAllowance(input);
    expect(r.status).toBe("NO_POLICY");
    expect(r.availableNow).toBe("0");
  });

  it("a policy for a different agent is an ERROR, never trusted", async () => {
    const r = await S([await provider("a", view(policy({ agent_id: "someone-else.testnet" })))]).checkSpendAllowance(input);
    expect(r.status).toBe("UNKNOWN");
    expect(r.providers[0]!.answer).toBe("ERROR");
  });

  it("UNKNOWN (nothing available) when no provider answers", async () => {
    const r = await S([await provider("a", { fault: { type: "http-502" } })]).checkSpendAllowance(input);
    expect(r.status).toBe("UNKNOWN");
    expect(r.availableNow).toBe("0");
  });

  it("rejects invalid account IDs before any network call", async () => {
    await expect(S([await provider("a", view(null))]).checkSpendAllowance({ ...input, agentId: "Not Valid" })).rejects.toBeInstanceOf(SentinelInputError);
    expect(seen).toHaveLength(0);
  });
});
