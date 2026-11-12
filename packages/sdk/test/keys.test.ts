import { afterEach, describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { SentinelInputError } from "../src/errors.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";
import type { ProviderConfig } from "../src/types.js";

const AGENT = "agent.alice.testnet";
const VAULT = "vault.alice.testnet";
const PK = (n: number) => `ed25519:${String(n).repeat(44).slice(0, 44).replace(/0/g, "1")}`;
const full = (n = 1) => ({ public_key: PK(n), access_key: { nonce: 1, permission: "FullAccess" } });
const fc = (n: number, receiver_id: string, method_names: string[], allowance: string | null = "1000000000000000000000000") => ({
  public_key: PK(n),
  access_key: { nonce: 1, permission: { FunctionCall: { allowance, receiver_id, method_names } } },
});
const list = (keys: unknown[], height = 5000): MockAnswer => ({ result: { keys, block_height: height, block_hash: "x" } });

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

describe("auditAgentKeys (read-only key audit)", () => {
  it("sends view_access_key_list at finality=final", async () => {
    await S([await provider("a", list([]))]).auditAgentKeys({ accountId: AGENT });
    expect(seen.map((x) => x.method)).toEqual(["query", "query"]);
    expect(seen.map((x) => x.params)).toContainEqual({ request_type: "view_access_key_list", finality: "final", account_id: AGENT });
    expect(seen.map((x) => x.params)).toContainEqual({ request_type: "view_account", finality: "final", account_id: AGENT });
  });

  it("FULL_ACCESS_PRESENT: critical finding and setup commands with placeholders only", async () => {
    const r = await S([await provider("a", list([full(), fc(2, VAULT, ["spend"])]))]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.status).toBe("FULL_ACCESS_PRESENT");
    expect(r.counts).toEqual({ fullAccess: 1, functionCall: 1 });
    expect(r.keys[0]).toMatchObject({ kind: "FULL_ACCESS", risk: "critical", allowance: null });
    expect(r.keys[0]!.why).toMatch(/move all NEAR/);
    expect(r.keys[1]!.risk).toBe("good");
    expect(r.blockHeight).toBe(5000);
    expect(r.setup).toEqual([
      `near account add-key ${AGENT} grant-function-call-access --allowance '1 NEAR' --contract-account-id ${VAULT} --function-names 'spend' autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send`,
      `# Only if the owner keeps ANOTHER full-access key for this account offline (or after moving its NEAR out):\n# deleting the LAST full-access key is irreversible: the account could never change keys or withdraw again.\nnear account delete-keys ${AGENT} public-keys <ed25519:FULL_ACCESS_KEY> network-config testnet sign-with-keychain send`,
    ]);
    expect(r.keys[0]!.fix).toMatch(/locks the account for good/);
    for (const c of r.setup!) expect(c).not.toContain(PK(1));
    expect(r.providers[0]).toMatchObject({ provider: "a", answer: "KEYS", keyCount: 2, blockHeight: 5000 });
    expect(r.providers[0]).not.toHaveProperty("rawKeys");
  });

  it("LEAST_PRIVILEGE: a vault key limited to spend is good, no setup needed", async () => {
    const r = await S([await provider("a", list([fc(2, VAULT, ["spend"], null)]))]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.status).toBe("LEAST_PRIVILEGE");
    expect(r.keys[0]).toMatchObject({ kind: "FUNCTION_CALL", risk: "good", receiverId: VAULT, methodNames: ["spend"], allowance: null });
    expect(r.keys[0]!.why).toMatch(/unlimited gas allowance \(fees only\)/);
    expect(r.setup).toBeUndefined();
  });

  it("vault key with all methods or other methods is review, with a fix", async () => {
    const r = await S([await provider("a", list([fc(2, VAULT, []), fc(3, VAULT, ["spend", "set_policy"])]))]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.status).toBe("REVIEW_NEEDED"); // only spend-only vault keys are least privilege
    expect(r.keys.map((k) => k.risk)).toEqual(["review", "review"]);
    expect(r.keys[0]!.why).toMatch(/every method/);
    expect(r.keys[0]!.fix).toMatch(/'spend'/);
    expect(r.setup).toHaveLength(1); // add-key only: no full-access key to delete
    expect(r.reason).toMatch(/2 function-call keys are not proven least privilege/);
  });

  it("key for another contract is review: cannot transfer NEAR", async () => {
    const r = await S([await provider("a", list([fc(2, "game.testnet", ["play"])]))]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.keys[0]).toMatchObject({ risk: "review", receiverId: "game.testnet" });
    expect(r.keys[0]!.why).toMatch(/cannot transfer NEAR itself or attach a deposit, but check what that contract's methods can do/);
    expect(r.status).toBe("REVIEW_NEEDED");
  });

  it("a key calling the account's own contract is critical (a wallet contract there may move NEAR)", async () => {
    const r = await S([await provider("a", list([fc(2, AGENT, [])]))]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.keys[0]).toMatchObject({ risk: "critical", receiverId: AGENT });
    expect(r.status).toBe("REVIEW_NEEDED");
    expect(r.reason).toMatch(/1 can call this account's own contract/);
  });

  it("without a vault, function-call keys are only 'review' (least privilege cannot be confirmed) and the setup uses <vault>", async () => {
    const r = await S([await provider("a", list([fc(2, "game.testnet", ["play"]), full(4)]))]).auditAgentKeys({ accountId: AGENT });
    expect(r.keys[0]!.risk).toBe("review");
    expect(r.keys[0]!.why).toMatch(/Give the vault contract/);
    expect(r.vaultContractId).toBeUndefined();
    expect(r.setup![0]).toContain("--contract-account-id <vault>");
  });

  it("NO_KEYS when the account has no access keys", async () => {
    const r = await S([await provider("a", list([]))]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("NO_KEYS");
    expect(r.keys).toEqual([]);
    expect(r.setup).toBeUndefined();
  });

  it("ACCOUNT_NOT_FOUND from a legacy result.error string", async () => {
    const r = await S([
      await provider("a", { result: { error: `account ${AGENT} does not exist while viewing`, logs: [], block_height: 5001, block_hash: "x" } }),
    ]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("ACCOUNT_NOT_FOUND");
    expect(r.providers[0]).toMatchObject({ answer: "NOT_FOUND", blockHeight: 5001 });
  });

  it("ACCOUNT_NOT_FOUND from a structured UNKNOWN_ACCOUNT error", async () => {
    const r = await S([
      await provider("a", { error: { code: -32000, name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, message: "Server error" } }),
    ]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("ACCOUNT_NOT_FOUND");
  });

  it("ACCOUNT_NOT_FOUND when the key list is empty and view_account says UNKNOWN_ACCOUNT (live nearcore form)", async () => {
    const srv = await startMockRpc((_m, params) =>
      params.request_type === "view_access_key_list"
        ? list([], 7000)
        : { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", data: `account ${AGENT} does not exist while viewing`, cause: { name: "UNKNOWN_ACCOUNT", info: {} } } },
    );
    servers.push(srv);
    const r = await S([{ name: "a", url: srv.url, operator: "a" }]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("ACCOUNT_NOT_FOUND");
    expect(r.blockHeight).toBe(7000);
  });

  it("empty key list is not NO_KEYS unless the account is confirmed", async () => {
    const srv = await startMockRpc((_m, params) => (params.request_type === "view_access_key_list" ? list([]) : { fault: { type: "http-502" } }));
    servers.push(srv);
    const r = await S([{ name: "a", url: srv.url, operator: "a" }]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("UNKNOWN");
    expect(r.providers[0]!.error).toMatch(/could not be confirmed/);
  });

  it("UNKNOWN when no provider answers (502)", async () => {
    const r = await S([await provider("a", { fault: { type: "http-502" } })]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("UNKNOWN");
    expect(r.providers[0]!.answer).toBe("ERROR");
    expect(r.keys).toEqual([]);
  });

  it("malformed answers are ERROR, never trusted", async () => {
    const r = await S([await provider("a", { result: { keys: [{ public_key: 1 }], block_height: 1 } })]).auditAgentKeys({ accountId: AGENT });
    expect(r.status).toBe("UNKNOWN");
  });

  it("provider split: the riskiest answer wins, so a higher-block clean list cannot hide a full-access key", async () => {
    const r = await S([
      await provider("honest", list([full()], 5000)),
      await provider("liar", list([fc(2, VAULT, ["spend"])], 6000)),
    ]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.status).toBe("FULL_ACCESS_PRESENT");
    expect(r.blockHeight).toBe(5000);
    expect(r.reason).toMatch(/Providers disagree; showing the riskiest answer \(honest, block 5000\)/);
  });

  it("provider split with equal risk: the highest block wins", async () => {
    const r = await S([
      await provider("lagging", list([fc(2, VAULT, ["spend"])], 5000)),
      await provider("fresh", list([fc(3, VAULT, ["spend"])], 6000)),
    ]).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.status).toBe("LEAST_PRIVILEGE");
    expect(r.blockHeight).toBe(6000);
  });

  it("mainnet sentinel prints mainnet commands", async () => {
    const srv = await startMockRpc(() => list([full()]));
    servers.push(srv);
    const r = await new NearSentinel({ rpcProviders: [{ name: "a", url: srv.url, operator: "a" }], network: "mainnet", timeoutMs: 1500 }).auditAgentKeys({ accountId: AGENT, vaultContractId: VAULT });
    expect(r.setup![0]).toContain("network-config mainnet");
  });

  it("rejects invalid account IDs before any network call", async () => {
    await expect(S([await provider("a", list([]))]).auditAgentKeys({ accountId: "Not Valid" })).rejects.toBeInstanceOf(SentinelInputError);
    expect(seen).toHaveLength(0);
  });
});
