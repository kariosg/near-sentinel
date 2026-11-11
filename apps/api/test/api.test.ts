import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockRpc, type MockAnswer, type RunningServer } from "@near-sentinel/sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../src/app.js";
import { sha256Hex } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { loadEnv } from "../src/env.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { base58Decode, IDENTITY_MESSAGE, IDENTITY_RECIPIENT, nep413Hash, NonceStore } from "../src/identity.js";
import { renderMetrics } from "../src/metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const success = JSON.parse(readFileSync(join(here, "../../../packages/sdk/test/fixtures/tx-success.json"), "utf8"));
const UNKNOWN_TX: MockAnswer = { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };
const intentView = (params: any): MockAnswer | undefined => {
  if (params?.request_type !== "call_function" || params.method_name !== "get_intent") return undefined;
  const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
  const value =
    args.payer_id === "agent.testnet" && args.intent_id === "paid-1"
      ? { payer_id: "agent.testnet", intent_id: "paid-1", receiver_id: "merchant.testnet", amount: "995000000000000000000000", block_height: 900, status: "Paid" }
      : null;
  return { result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1000, block_hash: "x" } };
};
const policyView = (params: any): MockAnswer | undefined => {
  if (params?.request_type !== "call_function" || params.method_name !== "get_policy") return undefined;
  const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
  const value =
    args.owner_id === "owner.testnet" && args.agent_id === "agent.testnet"
      ? { owner_id: "owner.testnet", agent_id: "agent.testnet", balance: "2000000000000000000000000", per_payment_max: "1000000000000000000000000", daily_max: "1500000000000000000000000", spent_in_window: "500000000000000000000000", available_now: "1000000000000000000000000", window_resets_at_ms: 1800000000000, allowed_receivers: ["shop.testnet"], frozen: false }
      : null;
  return { result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1000, block_hash: "x" } };
};
const keys: { full?: string; fc?: string } = {};
const accessKeyView = (params: any): MockAnswer | undefined => {
  if (params?.request_type !== "view_access_key") return undefined;
  if (params.account_id === "agent.testnet" && params.public_key === keys.full) return { result: { nonce: 1, permission: "FullAccess", block_height: 1000, block_hash: "x" } };
  if (params.account_id === "agent.testnet" && params.public_key === keys.fc)
    return { result: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } }, block_height: 1000, block_hash: "x" } };
  return { result: { block_height: 1000, block_hash: "x", error: `access key ${params.public_key} does not exist while viewing`, logs: [] } };
};
const KEY = "test-key-please-change";

const state = { aDown: false, chain: "testnet", txCalls: 0 };
const handler = (method: string, params: any): MockAnswer => {
  if (state.aDown) return { fault: { type: "http-502" } };
  if (method === "EXPERIMENTAL_tx_status") {
    state.txCalls++;
    return params.tx_hash === success.transaction.hash ? { result: success, delayMs: 30 } : UNKNOWN_TX;
  }
  if (method === "status") return { result: { chain_id: state.chain, protocol_version: 88, sync_info: { latest_block_height: 1000, earliest_block_height: 1, syncing: false } } };
  if (method === "block") return { error: { name: "HANDLER_ERROR", code: -32000, message: "x", cause: { name: "UNKNOWN_BLOCK" } } };
  if (method === "query") return (intentView(params) ?? policyView(params)) ?? accessKeyView(params) ?? UNKNOWN_TX;
  return UNKNOWN_TX;
};
const bHandler = (method: string, params: any): MockAnswer => {
  if (method === "status") return { result: { chain_id: "testnet", protocol_version: 88, sync_info: { latest_block_height: 1000, earliest_block_height: 1, syncing: false } } };
  if (method === "EXPERIMENTAL_tx_status") return params.tx_hash === success.transaction.hash ? { result: success } : UNKNOWN_TX;
  if (method === "query") return (intentView(params) ?? policyView(params)) ?? accessKeyView(params) ?? UNKNOWN_TX;
  return UNKNOWN_TX;
};

let a: RunningServer, b: RunningServer, mainnetRpc: RunningServer;
let d: AppDeps;

function env(over: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DISABLE_PROBER: "1",
    METRICS_PORT: "0",
    ALLOW_PRIVATE_RPC: "1",
    RPC_URLS: `alpha=${a.url}|op-a,beta=${b.url}|op-b`,
    API_KEYS_SHA256: sha256Hex(KEY),
    RATE_LIMIT_MAX: "1000",
    INSPECT_RATE_LIMIT_MAX: "1000",
    ...over,
  });
}

beforeAll(async () => {
  a = await startMockRpc(handler);
  b = await startMockRpc(bHandler);
  mainnetRpc = await startMockRpc(() => ({ result: { chain_id: "mainnet", sync_info: {} } }));
  d = await buildApp(env(), { db: openDb(":memory:") });
});
afterAll(async () => {
  await d.app.close();
  await Promise.all([a.close(), b.close(), mainnetRpc.close()]);
});

const auth = { authorization: `Bearer ${KEY}` };
const inspectBody = { transactionHash: success.transaction.hash, senderAccountId: success.transaction.signer_id };

describe("system", () => {
  it("GET /health + request id generated and echoed", async () => {
    const r = await d.app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("ok");
    expect(r.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const r2 = await d.app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "abc-123" } });
    expect(r2.headers["x-request-id"]).toBe("abc-123");
    const r3 = await d.app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "bad id with spaces <script>" } });
    expect(r3.headers["x-request-id"]).not.toContain("<");
  });

  it("security headers: nosniff, no-referrer and anti-framing on every response", async () => {
    for (const url of ["/health", "/api/v1/providers", "/does-not-exist"]) {
      const r = await d.app.inject({ method: "GET", url });
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    }
  });

  it("cold start: concurrent health requests share the first probe and always get providers (regression)", async () => {
    const d5 = await buildApp(env(), { db: openDb(":memory:") });
    const [r1, r2, r3] = await Promise.all([
      d5.prober.runOnce(),
      d5.app.inject({ method: "GET", url: "/api/v1/providers/health" }),
      d5.app.inject({ method: "GET", url: "/api/v1/providers/health" }),
    ]);
    expect(r1.providers).toHaveLength(2);
    for (const r of [r2, r3]) {
      expect(r.statusCode).toBe(200);
      expect(r.json().providers).toHaveLength(2);
    }
    await d5.app.close();
  });

  it("GET /ready is 503 before the first probe and 200 after", async () => {
    const r = await d.app.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(503);
    expect(r.json().reason).toMatch(/first provider probe/);
    await d.prober.runOnce();
    const r2 = await d.app.inject({ method: "GET", url: "/ready" });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().reachableProviders).toBe(2);
  });

  it("unknown route → 404 with the standard error envelope", async () => {
    const r = await d.app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatchObject({ code: "NOT_FOUND", requestId: expect.any(String) });
  });

  it("OpenAPI document is served", async () => {
    const r = await d.app.inject({ method: "GET", url: "/docs/json" });
    expect(r.statusCode).toBe(200);
    const paths = Object.keys(r.json().paths);
    expect(paths).toEqual(expect.arrayContaining(["/api/v1/transactions/inspect", "/api/v1/transactions/retry-check", "/api/v1/benchmarks/run"]));
  });
});

describe("transactions", () => {
  it("POST inspect → found on both providers, report saved and retrievable", async () => {
    const r = await d.app.inject({ method: "POST", url: "/api/v1/transactions/inspect", payload: inspectBody });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.state).toBe("EXECUTED_SUCCESS");
    expect(j.agreement).toBe("UNANIMOUS");
    expect(j.retryRecommendation.verdict).toBe("DO_NOT_RETRY");
    expect(j.reportId).toMatch(/^[0-9a-f-]{36}$/);
    const rep = await d.app.inject({ method: "GET", url: `/api/v1/reports/${j.reportId}` });
    expect(rep.json().schema).toBe("near-sentinel/diagnostic-report@1");
    const list = await d.app.inject({ method: "GET", url: "/api/v1/reports?limit=5" });
    expect(list.json().items[0].id).toBe(j.reportId);
  });

  it("input validation: bad hash, unknown field, missing sender → 400 INVALID_INPUT, no upstream calls", async () => {
    const before = state.txCalls;
    for (const payload of [
      { transactionHash: "zzz", senderAccountId: "alice.testnet" },
      { ...inspectBody, privateKey: "ed25519:..." },
      { transactionHash: success.transaction.hash },
    ]) {
      const r = await d.app.inject({ method: "POST", url: "/api/v1/transactions/inspect", payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("INVALID_INPUT");
      expect(r.json().error.requestId).toBeTruthy();
    }
    const r = await d.app.inject({ method: "GET", url: `/api/v1/transactions/not-a-hash?sender=alice.testnet` });
    expect(r.statusCode).toBe(400);
    expect(state.txCalls).toBe(before);
  });

  it("retry-check on an unknown hash → WAIT_AND_RECHECK; repeated check gives the same verdict", async () => {
    const body = { transactionHash: "11111111111111111111111111111111", senderAccountId: "alice.testnet", save: false };
    const r1 = await d.app.inject({ method: "POST", url: "/api/v1/transactions/retry-check", payload: body });
    const r2 = await d.app.inject({ method: "POST", url: "/api/v1/transactions/retry-check", payload: body });
    expect(r1.json().verdict).toBe("WAIT_AND_RECHECK");
    expect(r2.json().verdict).toBe(r1.json().verdict);
    expect(r1.json().reportId).toBeUndefined();
  });

  it("concurrent identical checks are single-flighted (one upstream fan-out)", async () => {
    const before = state.txCalls;
    const reqs = Array.from({ length: 5 }, () => d.app.inject({ method: "POST", url: "/api/v1/transactions/retry-check", payload: { ...inspectBody, save: false } }));
    const res = await Promise.all(reqs);
    expect(res.every((r) => r.json().verdict === "DO_NOT_RETRY")).toBe(true);
    expect(state.txCalls - before).toBe(1); // provider alpha was asked once, not 5 times
  });

  it("GET by hash, receipts and diagnostics", async () => {
    const q = `?sender=${success.transaction.signer_id}`;
    const t = await d.app.inject({ method: "GET", url: `/api/v1/transactions/${success.transaction.hash}${q}` });
    expect(t.json().state).toBe("EXECUTED_SUCCESS");
    const rc = await d.app.inject({ method: "GET", url: `/api/v1/transactions/${success.transaction.hash}/receipts${q}` });
    expect(rc.json().receiptTree.actions[0].methodName).toBe("request_credit");
    const dg = await d.app.inject({ method: "GET", url: `/api/v1/transactions/${success.transaction.hash}/diagnostics${q}` });
    expect(dg.json().retryRecommendation.verdict).toBe("DO_NOT_RETRY");
  });

  it("POST diagnose/error classifies a real nearcore timeout body", async () => {
    const r = await d.app.inject({
      method: "POST",
      url: "/api/v1/diagnose/error",
      payload: { error: { name: "HANDLER_ERROR", cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error" } },
    });
    expect(r.json().code).toBe("RPC_TIMEOUT");
    expect(r.json().retry).toBe("unknown");
  });
});

describe("protected operations", () => {
  it("real benchmark: no key / wrong key → 401 and an audit row", async () => {
    const r1 = await d.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", payload: { kind: "real" } });
    expect(r1.statusCode).toBe(401);
    const r2 = await d.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", payload: { kind: "real" }, headers: { authorization: "Bearer wrong" } });
    expect(r2.statusCode).toBe(401);
    // A missing/invalid kind must not slip past the key check.
    const r3 = await d.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", payload: {} });
    expect([400, 401]).toContain(r3.statusCode);
    const rows = d.db.prepare("SELECT outcome FROM audit_log WHERE action = 'benchmark.run'").all() as any[];
    expect(rows.filter((x) => x.outcome === "unauthorized").length).toBeGreaterThanOrEqual(2);
  });

  it("protected endpoints fail CLOSED when no keys are configured", async () => {
    const d2 = await buildApp(env({ API_KEYS_SHA256: "" }), { db: openDb(":memory:") });
    const r = await d2.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", payload: { kind: "real" }, headers: auth });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("PROTECTED_ENDPOINTS_DISABLED");
    await d2.app.close();
  });

  it("simulated benchmark is public (local mocks only) even with no keys configured; one run at a time", async () => {
    const d2 = await buildApp(env({ API_KEYS_SHA256: "" }), { db: openDb(":memory:") });
    const r = await d2.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", payload: { kind: "simulated" } });
    expect(r.statusCode).toBe(202);
    const busy = await d2.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", payload: { kind: "simulated" } });
    expect(busy.statusCode).toBe(409);
    await d2.app.close();
  });

  it("custom provider: wrong chain → 422; right chain → 201; listed; removed → 204", async () => {
    const bad = await d.app.inject({ method: "POST", url: "/api/v1/providers", headers: auth, payload: { name: "evil", url: mainnetRpc.url } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/chain_id=mainnet/);
    const good = await d.app.inject({ method: "POST", url: "/api/v1/providers", headers: auth, payload: { name: "gamma", url: b.url, operator: "op-g" } });
    expect(good.statusCode).toBe(201);
    const list = await d.app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(list.json().providers.find((p: any) => p.name === "gamma")).toMatchObject({ custom: true, operator: "op-g" });
    const dup = await d.app.inject({ method: "POST", url: "/api/v1/providers", headers: auth, payload: { name: "gamma", url: b.url } });
    expect(dup.statusCode).toBe(409);
    const del = await d.app.inject({ method: "DELETE", url: "/api/v1/providers/gamma", headers: auth });
    expect(del.statusCode).toBe(204);
    expect(d.runtime.sentinel.providers.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  it("SSRF: private/metadata URLs are rejected when private RPCs are not allowed", async () => {
    const d2 = await buildApp(env({ ALLOW_PRIVATE_RPC: "0", RPC_URLS: "" }), { db: openDb(":memory:") });
    for (const url of ["https://169.254.169.254/latest", "https://127.0.0.1", "https://localhost:443", "http://1.1.1.1", "https://[::1]"]) {
      const r = await d2.app.inject({ method: "POST", url: "/api/v1/providers", headers: auth, payload: { name: "x1", url } });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error.code).toBe("URL_REJECTED");
    }
    await d2.app.close();
  });
});

describe("benchmarks", () => {
  it("simulated fault benchmark: every scenario produces its expected classification", async () => {
    const start = await d.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", headers: auth, payload: { kind: "simulated" } });
    expect(start.statusCode).toBe(202);
    const id = start.json().id;
    const busy = await d.app.inject({ method: "POST", url: "/api/v1/benchmarks/run", headers: auth, payload: { kind: "simulated" } });
    expect(busy.statusCode).toBe(409);
    let run: any;
    for (let i = 0; i < 100; i++) {
      run = (await d.app.inject({ method: "GET", url: `/api/v1/benchmarks/${id}` })).json();
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(run.status).toBe("completed");
    expect(run.kind).toBe("simulated");
    const failed = run.result.scenarios.filter((s: any) => !s.pass);
    expect(failed, JSON.stringify(failed, null, 1)).toEqual([]);
    expect(run.result.total).toBeGreaterThanOrEqual(12);
    const listed = await d.app.inject({ method: "GET", url: "/api/v1/benchmarks?kind=real" });
    expect(listed.json().items.every((x: any) => x.kind === "real")).toBe(true);
  }, 60_000);
});

describe("incidents (automatic, debounced)", () => {
  it("one bad sample does nothing; two open PROVIDER_DOWN; recovery closes it", async () => {
    state.aDown = true;
    await d.prober.runOnce(Date.now() + 1);
    let open = (await d.app.inject({ method: "GET", url: "/api/v1/incidents?open=1" })).json().items;
    expect(open.filter((i: any) => i.provider === "alpha")).toHaveLength(0);
    await d.prober.runOnce(Date.now() + 2);
    open = (await d.app.inject({ method: "GET", url: "/api/v1/incidents?open=1" })).json().items;
    expect(open.find((i: any) => i.provider === "alpha" && i.kind === "PROVIDER_DOWN")).toBeTruthy();
    state.aDown = false;
    await d.prober.runOnce(Date.now() + 3);
    open = (await d.app.inject({ method: "GET", url: "/api/v1/incidents?open=1" })).json().items;
    expect(open.filter((i: any) => i.provider === "alpha")).toHaveLength(0);
    const all = (await d.app.inject({ method: "GET", url: "/api/v1/incidents" })).json().items;
    expect(all.find((i: any) => i.provider === "alpha").closedAt).toBeTruthy();
  });

  it("history endpoint returns persisted samples", async () => {
    const h = (await d.app.inject({ method: "GET", url: "/api/v1/providers/history?hours=1" })).json();
    expect(h.samples.length).toBeGreaterThanOrEqual(8);
  });

  it("Prometheus metrics render", () => {
    const text = renderMetrics(d.runtime);
    expect(text).toMatch(/sentinel_rpc_requests_total\{provider="alpha",operator="op-a",outcome="ok"\} \d+/);
    expect(text).toMatch(/sentinel_provider_up\{provider="alpha"\} 1/);
    expect(text).toMatch(/sentinel_open_incidents 0/);
  });
});

describe("rate limiting", () => {
  it("limits per client IP; spoofed X-Forwarded-For does not bypass it when TRUST_PROXY=0", async () => {
    const d3 = await buildApp(env({ RATE_LIMIT_MAX: "3" }), { db: openDb(":memory:") });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await d3.app.inject({ method: "GET", url: "/api/v1/providers", headers: { "x-forwarded-for": `10.0.0.${i}` } });
      codes.push(r.statusCode);
      if (r.statusCode === 429) expect(r.json().error.code).toBe("RATE_LIMITED");
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const h = await d3.app.inject({ method: "GET", url: "/health" });
    expect(h.statusCode).toBe(200); // health is never rate limited
    // Static dashboard assets are not counted (a 404 here is fine: no dashboard is built in this app).
    const asset = await d3.app.inject({ method: "GET", url: "/favicon.svg" });
    expect(asset.statusCode).not.toBe(429);
    await d3.app.close();
  });
});

describe("dashboard static serving", () => {
  it("serves assets (even ones created after start), SPA routes get index.html, missing assets are a real 404", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "ns-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>NS</title>");
    writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
    const d4 = await buildApp(env({ WEB_DIST: dir }), { db: openDb(":memory:") });
    const page = await d4.app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    const asset = await d4.app.inject({ method: "GET", url: "/assets/a.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript/);
    writeFileSync(join(dir, "assets", "b-after-start.js"), "console.log(2)"); // e.g. a rebuild while running
    const later = await d4.app.inject({ method: "GET", url: "/assets/b-after-start.js" });
    expect(later.statusCode).toBe(200);
    expect(later.headers["content-type"]).toMatch(/javascript/);
    const missing = await d4.app.inject({ method: "GET", url: "/assets/missing.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/json/);
    const spa = await d4.app.inject({ method: "GET", url: "/some/page/route" });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers["content-type"]).toMatch(/text\/html/);
    const api404 = await d4.app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(api404.json().error.code).toBe("NOT_FOUND");
    await d4.app.close();
  });
});

describe("environment validation", () => {
  it("refuses to start with bad config", () => {
    expect(() => loadEnv({ PORT: "99999" })).toThrow(/PORT/);
    expect(() => loadEnv({ API_KEYS_SHA256: "not-hex" })).toThrow(/API_KEYS_SHA256/);
    expect(() => loadEnv({ NEAR_NETWORK: "devnet" })).toThrow(/NEAR_NETWORK/);
  });
});

describe("vault allowance (read-only)", () => {
  const get = (url: string) => d.app.inject({ method: "GET", url });
  it("ACTIVE with limits and the amount available now", async () => {
    const r = await get("/api/v1/allowance?contract=vault.testnet&owner=owner.testnet&agent=agent.testnet");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ACTIVE", availableNow: "1000000000000000000000000", policy: { allowed_receivers: ["shop.testnet"] } });
  });
  it("NO_POLICY for an unknown agent", async () => {
    const r = await get("/api/v1/allowance?contract=vault.testnet&owner=owner.testnet&agent=other.testnet");
    expect(r.json()).toMatchObject({ status: "NO_POLICY", availableNow: "0" });
  });
  it.each([
    ["missing contract with no VAULT_CONTRACT_ID", "/api/v1/allowance?owner=owner.testnet&agent=agent.testnet"],
    ["bad account", "/api/v1/allowance?contract=vault.testnet&owner=NOPE&agent=agent.testnet"],
    ["unknown query param", "/api/v1/allowance?contract=vault.testnet&owner=owner.testnet&agent=agent.testnet&evil=1"],
  ])("400 on %s", async (_n, url) => {
    expect((await get(url)).statusCode).toBe(400);
  });
});

describe("guard contract intents (read-only)", () => {
  const get = (url: string) => d.app.inject({ method: "GET", url });
  it("PAID when the guard returns a record", async () => {
    const r = await get("/api/v1/intents?contract=guard.testnet&payer=agent.testnet&intent=paid-1");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "PAID", intent: { receiver_id: "merchant.testnet" }, resendSameIntentIsSafe: true });
  });
  it("NOT_RECORDED when every provider returns null", async () => {
    const r = await get("/api/v1/intents?contract=guard.testnet&payer=agent.testnet&intent=new-1");
    expect(r.json().status).toBe("NOT_RECORDED");
  });
  it.each([
    ["missing contract with no GUARD_CONTRACT_ID", "/api/v1/intents?payer=agent.testnet&intent=x"],
    ["bad intent id", "/api/v1/intents?contract=guard.testnet&payer=agent.testnet&intent=a%22b"],
    ["bad account", "/api/v1/intents?contract=NOPE&payer=agent.testnet&intent=x"],
    ["unknown query param", "/api/v1/intents?contract=guard.testnet&payer=agent.testnet&intent=x&evil=1"],
  ])("400 for %s", async (_n, url) => {
    const r = await get(url);
    expect(r.statusCode).toBe(400);
  });
  it("providers endpoint reports the configured guard contract (null when unset)", async () => {
    expect((await get("/api/v1/providers")).json().guardContractId).toBeNull();
  });
  it("GUARD_CONTRACT_ID is the default contract", async () => {
    const d2 = await buildApp(env({ GUARD_CONTRACT_ID: "guard.testnet" }), { db: openDb(":memory:") });
    try {
      const r = await d2.app.inject({ method: "GET", url: "/api/v1/intents?payer=agent.testnet&intent=paid-1" });
      expect(r.json()).toMatchObject({ contractId: "guard.testnet", status: "PAID" });
      expect((await d2.app.inject({ method: "GET", url: "/api/v1/providers" })).json().guardContractId).toBe("guard.testnet");
    } finally {
      await d2.app.close();
    }
  });
  it("rejects an invalid GUARD_CONTRACT_ID at startup", () => {
    expect(() => env({ GUARD_CONTRACT_ID: "Not Valid" })).toThrow(/GUARD_CONTRACT_ID/);
  });
});

/* ------------------------- optional NEP-413 verification ------------------------- */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
/** In-memory test key (never used on any chain). */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { pk: `ed25519:${b58(raw)}`, privateKey };
}

describe("optional account verification (NEP-413)", () => {
  const post = (url: string, body?: unknown) => d.app.inject({ method: "POST", url, payload: body as any });
  const signFor = (k: ReturnType<typeof testKey>, nonce: string, over: { recipient?: string; message?: string; callbackUrl?: string } = {}) =>
    sign(null, nep413Hash({ message: over.message ?? IDENTITY_MESSAGE, nonce: Buffer.from(nonce, "base64"), recipient: over.recipient ?? IDENTITY_RECIPIENT, callbackUrl: over.callbackUrl }), k.privateKey).toString("base64");

  it("base58 decoder round-trips (incl. leading zeros)", () => {
    for (const bytes of [Uint8Array.from([0, 0, 1, 2, 255]), Uint8Array.from(Array.from({ length: 32 }, (_, i) => i * 7))]) {
      expect([...base58Decode(b58(bytes))]).toEqual([...bytes]);
    }
  });

  it("challenge is optional, single-use material", async () => {
    const r = (await post("/api/v1/identity/challenge")).json();
    expect(r.optional).toBe(true);
    expect(Buffer.from(r.nonce, "base64")).toHaveLength(32);
    expect(r.recipient).toBe(IDENTITY_RECIPIENT);
  });

  it("verifies a valid signature from a FullAccess key; nonce cannot be reused", async () => {
    const k = testKey();
    keys.full = k.pk;
    const { nonce } = (await post("/api/v1/identity/challenge")).json();
    const body = { accountId: "agent.testnet", publicKey: k.pk, signature: signFor(k, nonce), nonce };
    const r = await post("/api/v1/identity/verify", body);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ verified: true, accountId: "agent.testnet", publicKey: k.pk });
    const again = await post("/api/v1/identity/verify", body);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/expired or already used/);
  });

  it("accepts wallets that include callbackUrl in the signed payload", async () => {
    const k = testKey();
    keys.full = k.pk;
    const { nonce } = (await post("/api/v1/identity/challenge")).json();
    const callbackUrl = "http://127.0.0.1:8080/#/overview";
    const r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: k.pk, signature: signFor(k, nonce, { callbackUrl }), nonce, callbackUrl });
    expect(r.statusCode).toBe(200);
  });

  it.each([
    ["wrong recipient", { recipient: "evil-app" }],
    ["different message", { message: "Send all my funds" }],
  ])("rejects a signature over a %s", async (_n, over) => {
    const k = testKey();
    keys.full = k.pk;
    const { nonce } = (await post("/api/v1/identity/challenge")).json();
    const r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: k.pk, signature: signFor(k, nonce, over), nonce });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/does not verify/);
  });

  it("rejects a signature by a different key than claimed", async () => {
    const k = testKey();
    const other = testKey();
    keys.full = k.pk;
    const { nonce } = (await post("/api/v1/identity/challenge")).json();
    const r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: k.pk, signature: signFor(other, nonce), nonce });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a nonce the server never issued", async () => {
    const k = testKey();
    keys.full = k.pk;
    const nonce = Buffer.alloc(32, 7).toString("base64");
    const r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: k.pk, signature: signFor(k, nonce), nonce });
    expect(r.statusCode).toBe(400);
  });

  it("rejects a valid signature whose key is only a FunctionCall key, or not on the account", async () => {
    const fc = testKey();
    keys.fc = fc.pk;
    let { nonce } = (await post("/api/v1/identity/challenge")).json();
    let r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: fc.pk, signature: signFor(fc, nonce), nonce });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/not a FullAccess key/);
    const stranger = testKey();
    ({ nonce } = (await post("/api/v1/identity/challenge")).json());
    r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: stranger.pk, signature: signFor(stranger, nonce), nonce });
    expect(r.statusCode).toBe(400);
  });

  it("a well-formed but wrong-length public key is a 400, not a 500", async () => {
    const { nonce } = (await post("/api/v1/identity/challenge")).json();
    const r = await post("/api/v1/identity/verify", { accountId: "agent.testnet", publicKey: `ed25519:${"1".repeat(43)}`, signature: Buffer.alloc(64, 1).toString("base64"), nonce });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/Invalid public key/);
  });

  it("rejects malformed bodies", async () => {
    expect((await post("/api/v1/identity/verify", { accountId: "agent.testnet" })).statusCode).toBe(400);
    expect((await post("/api/v1/identity/verify", { accountId: "x", publicKey: "ed25519:abc", signature: "no", nonce: "no", extra: 1 })).statusCode).toBe(400);
  });

  it("nonces expire after 5 minutes", () => {
    let t = 0;
    const store = new NonceStore(() => t);
    const { nonce } = store.issue();
    t += 5 * 60_000 + 1;
    expect(store.consume(nonce)).toBe(false);
  });
});

describe("abuse limits", () => {
  it("rejects bodies over the 2.5 MB limit with 413, not a crash", async () => {
    const big = JSON.stringify({ error: "x".repeat(3_000_000) });
    const r = await d.app.inject({ method: "POST", url: "/api/v1/diagnose/error", payload: big, headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(413);
  });

  it("caps event streams per client IP (429) and frees slots when streams close", async () => {
    const d5 = await buildApp(env(), { db: openDb(":memory:") });
    await d5.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = d5.app.server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/api/v1/events`;
    const ctrls: AbortController[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const c = new AbortController();
        ctrls.push(c);
        const r = await fetch(url, { signal: c.signal });
        expect(r.status).toBe(200);
      }
      const over = await fetch(url);
      expect(over.status).toBe(429);
      expect((await over.json()).error.code).toBe("TOO_MANY_STREAMS");
      ctrls.pop()!.abort();
      await new Promise((res) => setTimeout(res, 200));
      const c = new AbortController();
      ctrls.push(c);
      expect((await fetch(url, { signal: c.signal })).status).toBe(200);
    } finally {
      for (const c of ctrls) c.abort();
      await d5.app.close();
    }
  });
});
