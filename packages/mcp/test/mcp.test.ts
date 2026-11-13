/**
 * End-to-end: spawns the BUILT server (dist/server.js) as a subprocess over stdio and drives it
 * with the official MCP client. Providers are deterministic local mocks.
 * Run `pnpm build` first (the `test` script does it).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startMockRpc, type RunningServer } from "@near-sentinel/sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const success = JSON.parse(readFileSync(join(here, "../../sdk/test/fixtures/tx-success.json"), "utf8"));
const partial = JSON.parse(readFileSync(join(here, "../../sdk/test/fixtures/tx-partial.json"), "utf8"));
const UNKNOWN_TX = { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };

const view = (v: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 10, block_hash: "x" } });
const POLICY = {
  owner_id: "alice.testnet",
  agent_id: "agent.alice.testnet",
  balance: "2000000000000000000000000",
  per_payment_max: "1000000000000000000000000",
  daily_max: "1500000000000000000000000",
  spent_in_window: "0",
  available_now: "1000000000000000000000000",
  window_resets_at_ms: 1800000000000,
  allowed_receivers: [],
  frozen: false,
};

let a: RunningServer, b: RunningServer;
let client: Client;

const handler = (method: string, params: any) => {
  if (method === "EXPERIMENTAL_tx_status") {
    if (params.tx_hash === success.transaction.hash) return { result: success };
    if (params.tx_hash === partial.transaction.hash) return { result: partial };
    return UNKNOWN_TX;
  }
  if (method === "status") return { result: { chain_id: "testnet", protocol_version: 88, sync_info: { latest_block_height: 10, earliest_block_height: 1, syncing: false } } };
  if (method === "block") return { error: { name: "HANDLER_ERROR", code: -32000, message: "x", cause: { name: "UNKNOWN_BLOCK" } } };
  if (method === "query" && params?.request_type === "view_access_key_list")
    return { result: { keys: [{ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 1, permission: "FullAccess" } }], block_height: 10, block_hash: "x" } };
  if (method === "query" && params?.request_type === "view_account") {
    if (params.account_id === "karios.testnet" || params.account_id === "kari0s.testnet")
      return { result: { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1, block_height: 10, block_hash: "x" } };
    return { result: { error: `account ${params.account_id} does not exist while viewing`, logs: [], block_height: 10, block_hash: "x" } };
  }
  if (method === "query" && params?.method_name === "get_policy") return view(POLICY);
  if (method === "query" && params?.method_name === "get_spend") return view(null);
  return UNKNOWN_TX;
};

beforeAll(async () => {
  a = await startMockRpc(handler);
  b = await startMockRpc(handler);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "../dist/server.js")],
    env: {
      ...(process.env as Record<string, string>),
      NEAR_SENTINEL_NETWORK: "testnet",
      NEAR_SENTINEL_RPC_URLS: `alpha=${a.url}|op-a,beta=${b.url}|op-b`,
      NEAR_SENTINEL_ALLOW_PRIVATE: "1",
      NEAR_SENTINEL_TIMEOUT_MS: "3000",
    },
  });
  client = new Client({ name: "sentinel-test", version: "0.0.0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await a?.close();
  await b?.close();
});

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("near-sentinel MCP server (stdio, built)", () => {
  it("lists exactly the 10 read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "audit_agent_keys",
        "check_intent",
        "check_receiver",
        "check_retry_safety",
        "check_spend_allowance",
        "diagnose_submission_error",
        "inspect_transaction",
        "preflight_spend",
        "provider_health",
        "trace_receipts",
      ].sort(),
    );
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const check = tools.find((t) => t.name === "check_retry_safety")!;
    expect(check.description).toMatch(/BEFORE signing a new transaction/);
    expect(check.inputSchema.properties).toHaveProperty("signedTransactionBase64");
  });

  it("check_retry_safety on an executed tx → DO_NOT_RETRY with structured evidence", async () => {
    const r: any = await client.callTool({
      name: "check_retry_safety",
      arguments: { transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id },
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^VERDICT: DO_NOT_RETRY/);
    expect(r.structuredContent.retryRecommendation.verdict).toBe("DO_NOT_RETRY");
    expect(r.structuredContent.agreement).toBe("UNANIMOUS");
    expect(r.structuredContent.providers.map((p: any) => p.provider)).toEqual(["alpha", "beta"]);
    expect(r.structuredContent.observations).toBeUndefined(); // raw evidence only on request
  });

  it("includeRawEvidence returns the raw observations", async () => {
    const r: any = await client.callTool({
      name: "check_retry_safety",
      arguments: { transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id, includeRawEvidence: true },
    });
    expect(r.structuredContent.observations).toHaveLength(2);
  });

  it("check_retry_safety on an unknown tx → WAIT_AND_RECHECK", async () => {
    const r: any = await client.callTool({
      name: "check_retry_safety",
      arguments: { transactionHash: "11111111111111111111111111111111", senderAccountId: "alice.testnet" },
    });
    expect(r.structuredContent.retryRecommendation.verdict).toBe("WAIT_AND_RECHECK");
    expect(text(r)).toMatch(/Absence is not proof/);
    expect(text(r)).toMatch(/re-broadcast the IDENTICAL signed transaction bytes/);
  });

  it("executed tx verdict text does not suggest re-broadcasting", async () => {
    const r: any = await client.callTool({
      name: "check_retry_safety",
      arguments: { transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id },
    });
    expect(text(r)).not.toMatch(/re-broadcast/i);
  });

  it("trace_receipts renders the partial-failure tree", async () => {
    const r: any = await client.callTool({
      name: "trace_receipts",
      arguments: { transactionHash: partial.transaction.hash, senderAccountId: partial.transaction.signer_id },
    });
    const t = text(r);
    expect(t).toContain("state=PARTIALLY_COMPLETED");
    expect(t).toMatch(/✓ treasury\.amstr-admin-zxlhcx\.testnet \[run_buyback\]/);
    expect(t).toMatch(/✗ token\.amstr-admin-zxlhcx\.testnet \[ft_burn\]/);
  });

  it("diagnose_submission_error on a real nearcore timeout body → RPC_TIMEOUT, no network", async () => {
    const before = a.requests.length + b.requests.length;
    const r: any = await client.callTool({
      name: "diagnose_submission_error",
      arguments: {
        error: JSON.stringify({ name: "HANDLER_ERROR", cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error", data: "Timeout" }),
      },
    });
    expect(r.structuredContent.code).toBe("RPC_TIMEOUT");
    expect(text(r)).toMatch(/NOT_OBSERVED/);
    expect(a.requests.length + b.requests.length).toBe(before);
  });

  it("provider_health reports both mock providers", async () => {
    const r: any = await client.callTool({ name: "provider_health", arguments: {} });
    expect(r.structuredContent.providers.map((p: any) => [p.provider, p.reachable])).toEqual([
      ["alpha", true],
      ["beta", true],
    ]);
  });

  it("check_intent answers with a status and per-provider evidence (read-only view call)", async () => {
    const r: any = await client.callTool({ name: "check_intent", arguments: { contractId: "guard.example.testnet", payerId: "alice.testnet", intentId: "order-1" } });
    expect(r.isError).toBeFalsy();
    expect(["PAID", "PENDING", "NOT_RECORDED", "CONFLICTING", "UNKNOWN"]).toContain(r.structuredContent.status);
    expect(r.structuredContent.providers).toHaveLength(2);
    expect(text(r)).toMatch(/Intent order-1 for alice\.testnet/);
  });

  it("check_spend_allowance answers with a status and per-provider evidence (read-only view call)", async () => {
    const r: any = await client.callTool({ name: "check_spend_allowance", arguments: { contractId: "vault.example.testnet", ownerId: "alice.testnet", agentId: "agent.alice.testnet" } });
    expect(r.isError).toBeFalsy();
    expect(["ACTIVE", "EXHAUSTED", "FROZEN", "NO_POLICY", "UNKNOWN"]).toContain(r.structuredContent.status);
    expect(r.structuredContent.providers.length).toBeGreaterThan(0);
  });

  it("check_spend_allowance text includes the safety line", async () => {
    const r: any = await client.callTool({ name: "check_spend_allowance", arguments: { contractId: "vault.example.testnet", ownerId: "alice.testnet", agentId: "agent.alice.testnet" } });
    expect(r.structuredContent.safety.grade).toBe("fair");
    expect(text(r)).toMatch(/Safety: fair \(65\/100\) - \[high\] Any receiver allowed/);
  });

  it("preflight_spend: ALLOWED, then BLOCKED over the per-payment limit; tells agents the contract is final", async () => {
    const base = { contractId: "vault.example.testnet", ownerId: "alice.testnet", agentId: "agent.alice.testnet", receiverId: "shop.testnet" };
    const ok: any = await client.callTool({ name: "preflight_spend", arguments: { ...base, amountYocto: "100000000000000000000000", intentId: "order-9" } });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ decision: "ALLOWED", duplicate: false, costYocto: "106000000000000000000000" });
    expect(text(ok)).toMatch(/final judge/);
    const no: any = await client.callTool({ name: "preflight_spend", arguments: { ...base, amountYocto: "5000000000000000000000000" } });
    expect(no.structuredContent).toMatchObject({ decision: "BLOCKED", code: "OVER_PER_PAYMENT_LIMIT" });
    expect(text(no)).toMatch(/BLOCKED \(OVER_PER_PAYMENT_LIMIT\)/);
    const bad: any = await client.callTool({ name: "preflight_spend", arguments: { ...base, amountYocto: "0.1" } });
    expect(bad.isError).toBe(true);
  });

  it("check_receiver: DANGER for a lookalike, NOT_FOUND for a missing account, OK for a known one; bad input is a tool error", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "check_receiver")!.description).toMatch(/Call before paying anyone new.*DANGER or NOT_FOUND: do not pay; ask a human\. Read-only\./s);
    const r: any = await client.callTool({ name: "check_receiver", arguments: { receiverId: "kari0s.testnet", knownReceivers: ["karios.testnet"] } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "DANGER", lookalikeOf: "karios.testnet", exists: true });
    expect(r.structuredContent.findings[0].technique).toBe("homoglyph");
    expect(text(r).split("\n")).toHaveLength(3);
    expect(text(r)).toMatch(/^Receiver kari0s\.testnet: DANGER \(looks like karios\.testnet\)/);
    expect(text(r)).toMatch(/Providers: alpha=EXISTS, beta=EXISTS/);
    const missing: any = await client.callTool({ name: "check_receiver", arguments: { receiverId: "nobody-here.testnet" } });
    expect(missing.structuredContent.status).toBe("NOT_FOUND");
    const ok: any = await client.callTool({ name: "check_receiver", arguments: { receiverId: "karios.testnet", knownReceivers: ["karios.testnet"] } });
    expect(ok.structuredContent).toMatchObject({ status: "OK", knownReceiver: true });
    const bad: any = await client.callTool({ name: "check_receiver", arguments: { receiverId: "Not Valid" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/Treat it as UNKNOWN/);
  });

  it("audit_agent_keys reports a full-access key as critical", async () => {
    const r: any = await client.callTool({ name: "audit_agent_keys", arguments: { accountId: "agent.alice.testnet", vaultContractId: "vault.example.testnet" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "FULL_ACCESS_PRESENT", counts: { fullAccess: 1, functionCall: 0 } });
    expect(r.structuredContent.keys[0].risk).toBe("critical");
    expect(text(r)).toMatch(/FULL_ACCESS_PRESENT/);
    const bad: any = await client.callTool({ name: "audit_agent_keys", arguments: { accountId: "Not Valid" } });
    expect(bad.isError).toBe(true);
  });

  it("check_spend_allowance rejects an invalid account id as a tool error", async () => {
    const r: any = await client.callTool({ name: "check_spend_allowance", arguments: { contractId: "vault.example.testnet", ownerId: "alice.testnet", agentId: "Not Valid" } });
    expect(r.isError).toBe(true);
  });

  it("check_intent rejects a malformed intent id as a tool error", async () => {
    const r: any = await client.callTool({ name: "check_intent", arguments: { contractId: "guard.example.testnet", payerId: "alice.testnet", intentId: 'bad"id' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Treat it as UNKNOWN/);
  });

  it("invalid input is reported as a tool error that says to treat the tx as UNKNOWN", async () => {
    const r: any = await client.callTool({ name: "check_retry_safety", arguments: { transactionHash: "not-a-hash", senderAccountId: "alice.testnet" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Treat the transaction as UNKNOWN/);
  });
});
