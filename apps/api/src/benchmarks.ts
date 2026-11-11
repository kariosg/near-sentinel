/**
 * Reliability benchmarking.
 *
 *  REAL      — measures the configured providers against live NEAR data. Uses a RECENT real
 *              transaction (picked at run time) so results are not skewed by garbage collection.
 *  SIMULATED — deterministic fault scenarios run against local mock RPCs through the fault proxy.
 *              Each scenario declares its expected outcome up front; the run reports pass/fail.
 *
 * The two kinds are stored with a `kind` column and are never mixed in one result.
 */
import { randomUUID } from "node:crypto";
import {
  MIN_SAMPLE,
  NearSentinel,
  outcomeDigest,
  type RawTxStatusResult,
  type RpcObservation,
} from "@near-sentinel/sdk";
import { startFaultProxy, startMockRpc, type Fault, type MockAnswer } from "@near-sentinel/sdk/testing";
import type { Db } from "./db.js";
import type { Runtime } from "./runtime.js";

/* ---------------------------------- utils ---------------------------------- */

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function save(db: Db, id: string, kind: "real" | "simulated", status: string, params: unknown, result?: unknown, finished = false) {
  db.prepare(
    `INSERT INTO benchmark_runs (id, kind, status, started_at, finished_at, params, result) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, result = excluded.result`,
  ).run(id, kind, status, new Date().toISOString(), finished ? new Date().toISOString() : null, JSON.stringify(params), result === undefined ? null : JSON.stringify(result));
}

/* ------------------------------- real benchmark ------------------------------ */

export interface RealParams {
  rounds: number;
  intervalMs: number;
}

/** Find a recent transaction in the last few final blocks (read with failover). */
async function pickRecentTx(s: NearSentinel): Promise<{ hash: string; signer: string } | undefined> {
  const head = (await s.read<any>("block", { finality: "final" })).at(-1);
  if (!head?.ok) return undefined;
  for (let h = head.result.header.height; h > head.result.header.height - 30; h--) {
    const b = (await s.read<any>("block", { block_id: h })).at(-1);
    if (!b?.ok) continue;
    for (const c of b.result.chunks) {
      if (c.tx_root === "11111111111111111111111111111111") continue;
      const ch = (await s.read<any>("chunk", { chunk_id: c.chunk_hash })).at(-1);
      const t = ch?.ok ? ch.result.transactions?.[0] : undefined;
      if (t) return { hash: t.hash, signer: t.signer_id };
    }
  }
  return undefined;
}

export async function runRealBenchmark(rt: Runtime, id: string, p: RealParams, signal?: AbortSignal) {
  const s = rt.sentinel;
  const tx = await pickRecentTx(s);
  if (!tx) throw new Error("Could not find a recent transaction to benchmark against");
  const params = { tx_hash: tx.hash, sender_account_id: tx.signer, wait_until: "NONE" };
  const perProvider = new Map<string, { operator: string; obs: RpcObservation[]; digests: (string | null)[] }>();
  for (const pr of s.providers) perProvider.set(pr.name, { operator: pr.operator!, obs: [], digests: [] });

  for (let round = 0; round < p.rounds && !signal?.aborted; round++) {
    const cmp = await s.compareProviders({ method: "EXPERIMENTAL_tx_status", params }, { signal });
    for (const o of cmp.observations) {
      const slot = perProvider.get(o.provider)!;
      slot.obs.push(o);
      const r = o.ok ? (o.result as RawTxStatusResult) : undefined;
      slot.digests.push(r && Array.isArray(r.receipts_outcome) ? outcomeDigest(r) : null);
    }
    if (round < p.rounds - 1) await new Promise((r) => setTimeout(r, p.intervalMs));
  }

  // Majority digest across all FOUND answers = the reference outcome.
  const counts = new Map<string, number>();
  for (const v of perProvider.values()) for (const d of v.digests) if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const providers = [...perProvider.entries()].map(([name, v]) => {
    const answered = v.obs.filter((o) => o.ok || o.error?.kind === "RPC_ERROR");
    const lat = answered.map((o) => o.latencyMs).sort((a, b) => a - b);
    const errors: Record<string, number> = {};
    for (const o of v.obs) if (!o.ok && o.error) errors[o.error.causeName ?? o.error.kind] = (errors[o.error.causeName ?? o.error.kind] ?? 0) + 1;
    const found = v.digests.filter(Boolean).length;
    const agree = v.digests.filter((d) => d && d === majority).length;
    return {
      provider: name,
      operator: v.operator,
      samples: v.obs.length,
      sufficientSample: v.obs.length >= MIN_SAMPLE,
      availability: v.obs.length ? answered.length / v.obs.length : null,
      timeoutRate: v.obs.length ? v.obs.filter((o) => o.error?.kind === "TIMEOUT").length / v.obs.length : null,
      foundRate: v.obs.length ? found / v.obs.length : null,
      agreementRate: found ? agree / found : null,
      latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), min: lat[0] ?? null, max: lat.at(-1) ?? null },
      errors,
    };
  });

  return {
    kind: "real" as const,
    id,
    network: s.network,
    method: "EXPERIMENTAL_tx_status (wait_until NONE)",
    referenceTx: tx,
    rounds: p.rounds,
    intervalMs: p.intervalMs,
    minSampleForScores: MIN_SAMPLE,
    methodology:
      "Each round sends the same EXPERIMENTAL_tx_status request for one recent real transaction to every provider concurrently. " +
      "availability = answered (result or well-formed JSON-RPC error) / sent; latency percentiles use answered requests only; " +
      "agreementRate = answers whose outcome digest equals the majority digest / answers that found the tx. " +
      `Scores are flagged insufficient below ${MIN_SAMPLE} samples. A single run is a snapshot from one location, not a ranking.`,
    providers,
  };
}

/* ---------------------------- simulated benchmark ---------------------------- */

/** Minimal, internally consistent synthetic tx-status result (SYNTHETIC — not chain data). */
function syntheticTx(hash: string, opts: { failDownstream?: boolean; pendingChild?: boolean } = {}): RawTxStatusResult {
  const ok = { SuccessValue: "" };
  const fail = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: simulated" } } } } };
  const outcome = (id: string, executor: string, status: unknown, children: string[]) => ({
    id,
    block_hash: "11111111111111111111111111111111",
    outcome: { executor_id: executor, gas_burnt: 1000, tokens_burnt: "100", logs: [], receipt_ids: children, status },
  });
  const receipts_outcome = [outcome("R1", "app.testnet", { SuccessReceiptId: "R2" }, ["R2"])];
  if (!opts.pendingChild) receipts_outcome.push(outcome("R2", "token.testnet", opts.failDownstream ? fail : ok, []));
  return {
    final_execution_status: opts.pendingChild ? "INCLUDED" : "FINAL",
    status: opts.failDownstream ? fail : ok,
    transaction: { hash, signer_id: "alice.testnet", receiver_id: "app.testnet", public_key: "ed25519:x", nonce: 1, actions: [] },
    transaction_outcome: outcome(hash, "alice.testnet", { SuccessReceiptId: "R1" }, ["R1"]),
    receipts_outcome,
    receipts: [
      { receipt_id: "R1", predecessor_id: "alice.testnet", receiver_id: "app.testnet", receipt: { Action: { actions: [{ FunctionCall: { method_name: "run" } }] } } },
      { receipt_id: "R2", predecessor_id: "app.testnet", receiver_id: "token.testnet", receipt: { Action: { actions: [{ FunctionCall: { method_name: "ft_transfer" } }] } } },
    ],
  };
}

const SIM_HASH = "9WeBPyuE9vC6CSTUF2iSujGq7Use1B4SrSfcPZNkRsc8";
const UNKNOWN_TX: MockAnswer = { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };

interface Scenario {
  name: string;
  description: string;
  /** Fault applied by the proxy in front of provider A (provider B, when used, is healthy unless noted). */
  faultA?: Fault;
  /** Override what upstream A / B answer. */
  answerA?: (call: number) => MockAnswer;
  answerB?: (call: number) => MockAnswer;
  twoProviders?: boolean;
  /** Inspect this many times; the expectation applies to the LAST inspection. */
  inspections?: number;
  maxResponseBytes?: number;
  expect: { verdict: string; errorKindA?: string; diagnostic?: string; state?: string; agreement?: string };
}

const found = (r: RawTxStatusResult): MockAnswer => ({ result: r });

export const SCENARIOS: Scenario[] = [
  { name: "artificial-latency", description: "Provider answers correctly after 300 ms", faultA: { type: "delay", ms: 300 }, expect: { verdict: "DO_NOT_RETRY", state: "EXECUTED_SUCCESS" } },
  { name: "timeout", description: "Provider never answers (client deadline)", faultA: { type: "hang" }, expect: { verdict: "WAIT_AND_RECHECK", errorKindA: "TIMEOUT", diagnostic: "RPC_TIMEOUT", state: "UNKNOWN" } },
  { name: "connection-reset", description: "TCP connection destroyed mid-request", faultA: { type: "reset" }, expect: { verdict: "WAIT_AND_RECHECK", errorKindA: "NETWORK", diagnostic: "NETWORK_UNAVAILABLE" } },
  { name: "malformed-json", description: "Body is truncated, invalid JSON", faultA: { type: "malformed" }, expect: { verdict: "WAIT_AND_RECHECK", errorKindA: "MALFORMED", diagnostic: "MALFORMED_RESPONSE" } },
  { name: "rate-limited", description: "HTTP 429 with JSON-RPC -429", faultA: { type: "rate-limit" }, expect: { verdict: "WAIT_AND_RECHECK", errorKindA: "RATE_LIMITED", diagnostic: "RATE_LIMITED" } },
  { name: "oversized-response", description: "200 KB body against a 64 KB cap", faultA: { type: "oversized", bytes: 200_000 }, maxResponseBytes: 64_000, expect: { verdict: "WAIT_AND_RECHECK", errorKindA: "TOO_LARGE", diagnostic: "MALFORMED_RESPONSE" } },
  { name: "bad-gateway", description: "HTML 502 from a load balancer", faultA: { type: "http-502" }, expect: { verdict: "WAIT_AND_RECHECK", errorKindA: "HTTP_ERROR", diagnostic: "NETWORK_UNAVAILABLE" } },
  {
    name: "stale-provider",
    description: "Provider A falsely answers UNKNOWN_TRANSACTION; B has the tx",
    faultA: { type: "stale-unknown-tx" },
    twoProviders: true,
    expect: { verdict: "DO_NOT_RETRY", diagnostic: "PROVIDER_DISAGREEMENT", agreement: "CONSISTENT_WITH_LAG" },
  },
  {
    name: "inconsistent-response",
    description: "A and B return different executed outcomes for the same tx",
    twoProviders: true,
    answerA: () => found(syntheticTx(SIM_HASH)),
    answerB: () => found(syntheticTx(SIM_HASH, { failDownstream: true })),
    expect: { verdict: "MANUAL_REVIEW_REQUIRED", diagnostic: "PROVIDER_DISAGREEMENT", agreement: "CONFLICTING" },
  },
  {
    name: "missing-receipt",
    description: "Included tx whose downstream receipt outcome is not available yet",
    answerA: () => found(syntheticTx(SIM_HASH, { pendingChild: true })),
    expect: { verdict: "DO_NOT_RETRY", diagnostic: "RECEIPTS_PENDING", state: "INCLUDED" },
  },
  {
    name: "delayed-outcome",
    description: "First inspection: not found anywhere; second inspection: executed",
    answerA: (i) => (i === 0 ? UNKNOWN_TX : found(syntheticTx(SIM_HASH))),
    inspections: 2,
    expect: { verdict: "DO_NOT_RETRY", state: "EXECUTED_SUCCESS" },
  },
  {
    name: "downstream-failure",
    description: "Root receipt succeeds, cross-contract receipt fails",
    answerA: () => found(syntheticTx(SIM_HASH, { failDownstream: true })),
    expect: { verdict: "MANUAL_REVIEW_REQUIRED", state: "PARTIALLY_COMPLETED", diagnostic: "RECEIPT_EXECUTION_FAILURE" },
  },
];

async function runScenario(sc: Scenario) {
  let callsA = 0;
  let callsB = 0;
  const upA = await startMockRpc((m) => (m === "EXPERIMENTAL_tx_status" ? (sc.answerA ?? (() => found(syntheticTx(SIM_HASH))))(callsA++) : UNKNOWN_TX));
  const upB = sc.twoProviders
    ? await startMockRpc((m) => (m === "EXPERIMENTAL_tx_status" ? (sc.answerB ?? (() => found(syntheticTx(SIM_HASH))))(callsB++) : UNKNOWN_TX))
    : undefined;
  const proxy = await startFaultProxy(upA.url);
  if (sc.faultA) proxy.setFault("EXPERIMENTAL_tx_status", sc.faultA);
  try {
    const s = new NearSentinel({
      rpcProviders: [{ name: "A", url: proxy.url, operator: "sim-a" }, ...(upB ? [{ name: "B", url: upB.url, operator: "sim-b" }] : [])],
      timeoutMs: 1000,
      maxResponseBytes: sc.maxResponseBytes,
    });
    let last;
    for (let i = 0; i < (sc.inspections ?? 1); i++) last = await s.inspectTransaction({ transactionHash: SIM_HASH, senderAccountId: "alice.testnet" });
    const r = last!;
    const errorKindA = r.providers[0]?.error?.kind;
    const diagCodes = r.diagnostics.map((d) => d.code);
    const checks = {
      verdict: r.retryRecommendation.verdict === sc.expect.verdict,
      errorKindA: sc.expect.errorKindA === undefined || errorKindA === sc.expect.errorKindA,
      diagnostic: sc.expect.diagnostic === undefined || diagCodes.includes(sc.expect.diagnostic as any),
      state: sc.expect.state === undefined || r.state === sc.expect.state,
      agreement: sc.expect.agreement === undefined || r.agreement === sc.expect.agreement,
    };
    return {
      name: sc.name,
      description: sc.description,
      expected: sc.expect,
      observed: { verdict: r.retryRecommendation.verdict, errorKindA, diagnostics: diagCodes, state: r.state, agreement: r.agreement },
      pass: Object.values(checks).every(Boolean),
      checks,
    };
  } finally {
    await proxy.close();
    await upA.close();
    await upB?.close();
  }
}

export async function runSimulatedBenchmark(id: string) {
  const results = [];
  for (const sc of SCENARIOS) results.push(await runScenario(sc));
  return {
    kind: "simulated" as const,
    id,
    note: "SIMULATED: local mock RPCs and a fault-injection proxy. These results test Sentinel's classification logic; they say nothing about real providers.",
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    scenarios: results,
  };
}

/* --------------------------------- job runner -------------------------------- */

export class BenchmarkRunner {
  private active = new Map<string, AbortController>();
  constructor(private readonly rt: Runtime) {}

  get runningCount(): number {
    return this.active.size;
  }

  start(kind: "real" | "simulated", params: RealParams): string {
    if (this.active.size >= 1) throw Object.assign(new Error("A benchmark is already running"), { statusCode: 409, code: "BENCHMARK_BUSY" });
    const id = randomUUID();
    const ctrl = new AbortController();
    this.active.set(id, ctrl);
    save(this.rt.db, id, kind, "running", kind === "real" ? params : {});
    const job = kind === "real" ? runRealBenchmark(this.rt, id, params, ctrl.signal) : runSimulatedBenchmark(id);
    job
      .then((result) => save(this.rt.db, id, kind, ctrl.signal.aborted ? "aborted" : "completed", params, result, true))
      .catch((e) => save(this.rt.db, id, kind, "failed", params, { error: String(e?.message ?? e) }, true))
      // The DB may already be closed during shutdown; never let that become an unhandled rejection.
      .catch(() => undefined)
      .finally(() => this.active.delete(id));
    return id;
  }

  stopAll(): void {
    for (const c of this.active.values()) c.abort();
  }
}
