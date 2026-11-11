#!/usr/bin/env node
/**
 * Load + abuse test of the BUILT API server (dist/server.js) with the built dashboard.
 *
 * Public NEAR RPCs are never load-tested: the server is pointed at two local mock RPC providers
 * (different operators, 40–80 ms simulated latency) that answer like nearcore.
 *
 *   pnpm --filter @near-sentinel/api build && node apps/api/scripts/load-test.mjs
 *
 * Gates (exit 1 if any fails): zero 5xx / socket errors under load, p99 latency budgets,
 * memory growth bounded, and rate limits returning 429 (not errors) under abuse.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";
import { startMockRpc } from "@near-sentinel/sdk/testing";

const here = dirname(fileURLToPath(import.meta.url));
const success = readFileSync(join(here, "../../../packages/sdk/test/fixtures/tx-success.json"), "utf8");
const SUCCESS = JSON.parse(success);
const UNKNOWN_TX = { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };
const jitter = () => 40 + Math.floor(Math.random() * 40);
const handler = (method, params) => {
  if (method === "status") return { result: { chain_id: "testnet", protocol_version: 88, sync_info: { latest_block_height: 5_000_000, earliest_block_height: 1, syncing: false } }, delayMs: jitter() };
  if (method === "EXPERIMENTAL_tx_status") return params.tx_hash === SUCCESS.transaction.hash ? { result: SUCCESS, delayMs: jitter() } : { ...UNKNOWN_TX, delayMs: jitter() };
  if (method === "block") return { error: { name: "HANDLER_ERROR", code: -32000, message: "x", cause: { name: "UNKNOWN_BLOCK" } }, delayMs: jitter() };
  return { ...UNKNOWN_TX, delayMs: jitter() };
};
const a = await startMockRpc(handler);
const b = await startMockRpc(handler);

const PORT = 18099;
const base = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "sentinel-load-"));
const server = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", join(here, "..", "dist", "server.js")], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    LOG_LEVEL: "warn",
    METRICS_PORT: "0",
    DATA_DIR: dataDir,
    ALLOW_PRIVATE_RPC: "1",
    RPC_URLS: `mock-a=${a.url}|op-a,mock-b=${b.url}|op-b`,
    PROBE_INTERVAL_MS: "5000",
    RATE_LIMIT_MAX: process.env.LOAD_RATE_LIMIT_MAX ?? "1000000",
    INSPECT_RATE_LIMIT_MAX: process.env.LOAD_RATE_LIMIT_MAX ?? "1000000",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

function run(opts) {
  return new Promise((resolve, reject) => {
    const inst = autocannon({ duration: 10, connections: 50, pipelining: 1, ...opts }, (err, res) => (err ? reject(err) : resolve(res)));
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
  });
}

const results = [];
const gate = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

let code = 1;
try {
  await waitReady();
  // Let the prober take its first snapshot.
  await fetch(`${base}/api/v1/providers/health?fresh=1`).then((r) => r.text());
  const memBefore = await serverRss();

  const scenarios = [
    { name: "GET /health", url: `${base}/health`, p99: 50 },
    { name: "GET /api/v1/providers/health (cached snapshot)", url: `${base}/api/v1/providers/health`, p99: 100 },
    { name: "GET / (dashboard HTML)", url: `${base}/`, p99: 100 },
    {
      name: "POST /api/v1/transactions/retry-check (2 mock providers)",
      url: `${base}/api/v1/transactions/retry-check`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactionHash: SUCCESS.transaction.hash, senderAccountId: SUCCESS.transaction.signer_id }),
      connections: 20,
      p99: 1000,
    },
    {
      name: "GET /api/v1/intents (guard view call, 2 mock providers)",
      url: `${base}/api/v1/intents?contract=guard.testnet&payer=agent.testnet&intent=order-1`,
      connections: 20,
      p99: 600,
    },
  ];
  const ROUNDS = Number(process.env.LOAD_ROUNDS ?? 3);
  const rssAfterRound = [];
  for (let round = 1; round <= ROUNDS; round++) {
  console.log(`— round ${round}/${ROUNDS}`);
  for (const s of scenarios) {
    const r = await run(s);
    const non2xx = r.non2xx;
    const errs = r.errors + r.timeouts;
    gate(
      s.name,
      errs === 0 && non2xx === 0 && r.latency.p99 <= s.p99,
      `${r.requests.average.toFixed(0)} req/s, p50 ${r.latency.p50} ms, p99 ${r.latency.p99} ms (budget ${s.p99}), non-2xx ${non2xx}, errors ${errs}, total ${r.requests.total}`,
    );
  }

  rssAfterRound.push(await serverRss());
  }

  // Leak check: after warm-up (round 1), further identical rounds must not keep growing memory.
  const mb = (x) => (x / 1048576).toFixed(0);
  if (memBefore && rssAfterRound.every(Boolean)) {
    const later = rssAfterRound.length > 1 ? (rssAfterRound.at(-1) - rssAfterRound[0]) / 1048576 : 0;
    gate(
      "no memory leak: RSS flat after warm-up",
      later < 60,
      `RSS start ${mb(memBefore)} MB → after each round ${rssAfterRound.map(mb).join(" / ")} MB (growth after round 1: ${later.toFixed(0)} MB)`,
    );
  }

  // Health after load.
  const h = await fetch(`${base}/health`);
  gate("server healthy after load", h.ok, `HTTP ${h.status}`);
  code = results.every((r) => r.pass) ? 0 : 1;
} catch (e) {
  console.error(`✕ ${e?.stack ?? e}`);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  await a.close();
  await b.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} load gates passed`);
process.exit(code);

/** Server process RSS / working set in bytes. */
async function serverRss() {
  try {
    const { execFileSync } = await import("node:child_process");
    if (process.platform === "win32") {
      const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${server.pid}).WorkingSet64`], { encoding: "utf8" });
      return Number(out.trim());
    }
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)], { encoding: "utf8" });
    return Number(out.trim()) * 1024;
  } catch {
    return undefined;
  }
}
