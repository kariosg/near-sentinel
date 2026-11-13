import { describe, expect, it, vi } from "vitest";
import { guardedSpend, type GuardedSpendLog } from "../src/spend-guard.js";
import { decideSpendAction, type SpendPreflight } from "../src/vault.js";
import type { ReceiverCheck } from "../src/receiver.js";

const rc = (status: ReceiverCheck["status"], knownReceiver = false): ReceiverCheck =>
  ({ receiverId: "shop.testnet", status, kind: "named", knownReceiver, findings: [], reason: `${status}: test`, providers: [], checkedAt: "" }) as unknown as ReceiverCheck;

describe("decideSpendAction (fail closed)", () => {
  it.each([
    ["BLOCKED", rc("OK", true), "REFUSE"],
    ["BLOCKED", undefined, "REFUSE"],
    ["ALLOWED", rc("DANGER"), "REFUSE"],
    ["UNKNOWN", rc("DANGER"), "REFUSE"],
    ["UNKNOWN", rc("OK", true), "ASK_HUMAN"],
    ["ALLOWED", undefined, "ASK_HUMAN"],
    ["ALLOWED", rc("NOT_FOUND"), "ASK_HUMAN"],
    ["ALLOWED", rc("NOT_FOUND", true), "ASK_HUMAN"],
    ["ALLOWED", rc("WARNING"), "ASK_HUMAN"],
    ["ALLOWED", rc("UNKNOWN"), "ASK_HUMAN"],
    ["ALLOWED", rc("UNKNOWN", true), "SIGN"],
    ["ALLOWED", rc("WARNING", true), "SIGN"],
    ["ALLOWED", rc("OK"), "SIGN"],
  ] as const)("%s + receiver %o → %s", (decision, check, action) => {
    expect(decideSpendAction(decision, check).action).toBe(action);
  });
});

const spend = { contractId: "vault.alice.testnet", ownerId: "alice.testnet", agentId: "agent.alice.testnet", receiverId: "shop.testnet", amountYocto: "1000", intentId: "order-1" };
const pre = (action: SpendPreflight["action"]): SpendPreflight =>
  ({ decision: action === "REFUSE" ? "BLOCKED" : "ALLOWED", action, actionReason: `${action}: test`, reason: "", amount: "1000", receiverId: "shop.testnet", receiverCheck: rc("OK") }) as unknown as SpendPreflight;
const sentinelSaying = (action: SpendPreflight["action"]) => ({ preflightSpend: vi.fn(async () => pre(action)) });

describe("guardedSpend (agent-side wrapper)", () => {
  it("SIGN: signs exactly once and returns the result", async () => {
    const sign = vi.fn(async () => "tx-hash");
    const logs: GuardedSpendLog[] = [];
    const r = await guardedSpend({ sentinel: sentinelSaying("SIGN"), spend, sign, log: (l) => logs.push(l) });
    expect(r).toMatchObject({ outcome: "SIGNED", action: "SIGN", humanApproved: false, result: "tx-hash" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(logs.map((l) => l.step)).toEqual(["preflight", "sign"]);
  });

  it("REFUSE: never signs, never asks a human", async () => {
    const sign = vi.fn();
    const confirm = vi.fn(async () => true);
    const r = await guardedSpend({ sentinel: sentinelSaying("REFUSE"), spend, sign, confirm });
    expect(r).toMatchObject({ outcome: "REFUSED", action: "REFUSE" });
    expect(sign).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("ASK_HUMAN with no human configured: fails closed", async () => {
    const sign = vi.fn();
    const r = await guardedSpend({ sentinel: sentinelSaying("ASK_HUMAN"), spend, sign });
    expect(r.outcome).toBe("REFUSED");
    expect(sign).not.toHaveBeenCalled();
  });

  it("ASK_HUMAN: signs only on an explicit yes", async () => {
    for (const [answer, signed] of [[true, true], [false, false], ["yes", false], [undefined, false]] as const) {
      const sign = vi.fn(async () => "tx");
      const r = await guardedSpend({ sentinel: sentinelSaying("ASK_HUMAN"), spend, sign, confirm: async () => answer as unknown as boolean });
      expect(r.outcome).toBe(signed ? "SIGNED" : "REFUSED");
      expect(sign).toHaveBeenCalledTimes(signed ? 1 : 0);
      if (r.outcome === "SIGNED") expect(r.humanApproved).toBe(true);
    }
  });

  it("ASK_HUMAN: a confirm callback that throws counts as no", async () => {
    const sign = vi.fn();
    const r = await guardedSpend({ sentinel: sentinelSaying("ASK_HUMAN"), spend, sign, confirm: async () => { throw new Error("timeout"); } });
    expect(r.outcome).toBe("REFUSED");
    expect(sign).not.toHaveBeenCalled();
  });

  it("a failing preflight refuses without signing", async () => {
    const sign = vi.fn();
    const r = await guardedSpend({ sentinel: { preflightSpend: async () => { throw new Error("network down"); } }, spend, sign });
    expect(r).toMatchObject({ outcome: "REFUSED" });
    expect(r.outcome === "REFUSED" && r.reason).toMatch(/preflight failed \(network down\)/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("an unexpected action value refuses", async () => {
    const sign = vi.fn();
    const r = await guardedSpend({ sentinel: sentinelSaying("MAYBE" as never), spend, sign });
    expect(r.outcome).toBe("REFUSED");
    expect(sign).not.toHaveBeenCalled();
  });
});
