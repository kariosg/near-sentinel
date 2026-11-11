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
  it("lists exactly the 6 read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_intent", "check_retry_safety", "diagnose_submission_error", "inspect_transaction", "provider_health", "trace_receipts"].sort(),
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
