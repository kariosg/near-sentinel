import { diagnoseObservations, diagnoseOutcome, diagnoseSubmissionError, notFoundDiagnostic } from "./diagnostics.js";
import { plural } from "./text.js";
import { SentinelInputError } from "./errors.js";
import { MetricsCollector, type ProviderMetrics } from "./metrics.js";
import { ARCHIVAL_PROBE_HEIGHT, DEFAULT_PROVIDERS, DEFAULT_TX_VALIDITY_PERIOD, NULL_HASH } from "./networks.js";
import {
  buildReceiptTree,
  classifyFound,
  finalityRank,
  outcomeDigest,
  summarizeTransaction,
  totals,
  type RawTxStatusResult,
} from "./outcome.js";
import { decideIntent, decodeViewResult, isGuardIntent, intentInputSchema, type IntentCheck, type IntentInput, type IntentProviderAnswer } from "./intent.js";
import {
  assessAllowanceSafety,
  decideAllowance,
  decideSpendPreflight,
  preflightInputSchema,
  vaultAnswer,
  vaultInputSchema,
  type AllowanceCheck,
  type PreflightInput,
  type SpendPreflight,
  type VaultInput,
} from "./vault.js";
import { decideKeyAudit, keyAuditInputSchema, keyListAnswer, type KeyAudit, type KeyAuditInput } from "./keys.js";
import {
  decideReceiver,
  PROVIDERS_DISAGREE_TITLE,
  receiverAnswer,
  receiverCheckInputSchema,
  type ReceiverCheck,
  type ReceiverCheckInput,
  type ReceiverProviderObservation,
} from "./receiver.js";
import { decideRetry, type PerProviderRetryEvidence } from "./retry.js";
import { isMethodNotFound, isUnknownBlock, isUnknownTx, operatorOf, rpcCall, type FetchLike } from "./rpc.js";
import { decodeSignedTx } from "./signedtx.js";
import type {
  Diagnostic,
  DiagnosticReport,
  InspectionResult,
  ProviderConfig,
  ProviderHealth,
  ProviderVerdict,
  ReceiptNode,
  RetryRecommendation,
  RpcObservation,
  TxState,
} from "./types.js";
import { inspectInputSchema, isValidAccountId, parseOrThrow, type InspectInput } from "./validation.js";

export const SDK_VERSION = "0.1.0";

export interface NearSentinelOptions {
  network?: "mainnet" | "testnet";
  /** Overrides the default provider list. */
  rpcProviders?: ProviderConfig[];
  /** Per-request deadline. Default 8000ms. */
  timeoutMs?: number;
  /** Max bytes accepted per RPC response. Default 8 MiB. */
  maxResponseBytes?: number;
  /** Distinct operators that must independently prove non-execution before SAFE_TO_RETRY. Default 2. */
  minIndependentOperators?: number;
  /** Custom fetch (e.g. the SSRF-guarded fetch). */
  fetch?: FetchLike;
  /** Shared metrics sink. */
  metrics?: MetricsCollector;
  /** Called for every raw observation (for logging/streaming). Must not throw. */
  onObservation?: (o: RpcObservation) => void;
  /**
   * Before a "nonce consumed + not found" answer may count as proof, the tx is looked up again after this
   * delay. Public RPC endpoints are load-balanced pools: the nonce read and the tx lookup can hit different
   * backends, and a lagging one can miss a tx that already executed. Default 2500 ms; 0 re-checks immediately.
   */
  proofRecheckMs?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CompareResult {
  method: string;
  params: unknown;
  groups: Array<{ digest: string; providers: string[]; sample: unknown }>;
  errors: Array<{ provider: string; error: RpcObservation["error"] }>;
  agreement: "UNANIMOUS" | "SPLIT" | "INSUFFICIENT";
  observations: RpcObservation[];
}

interface ResolvedInput {
  txHash: string;
  signerId: string;
  nonce?: bigint;
  publicKey?: string;
  blockHash?: string;
  /** nonce / publicKey / blockHash were decoded from the signed tx (bound to the hash). */
  fromSignedTx: boolean;
}

/**
 * Never trust a provider's answer blindly: a "found" result must describe the tx we asked for and
 * have the structure the engine relies on. Otherwise it is downgraded to MALFORMED evidence.
 */
function validateTxResult(o: RpcObservation<RawTxStatusResult>, txHash: string): RpcObservation<RawTxStatusResult> {
  if (!o.ok) return o;
  const r = o.result as any;
  const problem =
    !r || typeof r !== "object"
      ? "result is not an object"
      : r.transaction?.hash !== txHash
        ? `provider returned a different transaction (${String(r.transaction?.hash).slice(0, 12)}…)`
        : !Array.isArray(r.receipts_outcome) || !r.transaction_outcome?.outcome || !Array.isArray(r.transaction_outcome.outcome.receipt_ids)
          ? "result lacks receipts_outcome / transaction_outcome"
          : r.receipts_outcome.some((x: any) => typeof x?.id !== "string" || !x?.outcome || !Array.isArray(x.outcome.receipt_ids))
            ? "receipt outcome entries are malformed"
            : undefined;
  if (!problem) return o;
  const { result: _drop, ...rest } = o;
  return { ...rest, ok: false, error: { kind: "MALFORMED", message: `Rejected tx-status answer: ${problem}` } };
}

const stableStringify = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as any)[k]]))
      : x,
  );

export class NearSentinel {
  readonly network: string;
  readonly providers: ProviderConfig[];
  readonly metrics: MetricsCollector;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly minOps: number;
  private readonly proofRecheckMs: number;
  private readonly fetchImpl?: FetchLike;
  private readonly onObservation?: (o: RpcObservation) => void;
  private validityPeriod?: number;
  private archivalCache = new Map<string, { value: boolean | null; at: number }>();

  constructor(opts: NearSentinelOptions = {}) {
    const net = opts.network ?? "testnet";
    this.network = opts.rpcProviders ? (opts.network ?? "custom") : net;
    this.providers = (opts.rpcProviders ?? DEFAULT_PROVIDERS[net]).map((p) => ({ ...p, operator: operatorOf(p) }));
    if (this.providers.length === 0) throw new SentinelInputError("At least one RPC provider is required");
    const names = new Set<string>();
    for (const p of this.providers) {
      if (!p.name || names.has(p.name)) throw new SentinelInputError(`Provider names must be unique and non-empty (${p.name})`);
      names.add(p.name);
      let u: URL;
      try {
        u = new URL(p.url);
      } catch {
        throw new SentinelInputError(`Invalid provider URL for ${p.name}`);
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new SentinelInputError(`Provider ${p.name} must be http(s)`);
    }
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
    this.minOps = Math.max(1, opts.minIndependentOperators ?? 2);
    this.proofRecheckMs = Math.max(0, opts.proofRecheckMs ?? 2500);
    this.fetchImpl = opts.fetch;
    this.metrics = opts.metrics ?? new MetricsCollector();
    this.onObservation = opts.onObservation;
  }

  /* ------------------------------- transport ------------------------------- */

  private async call<T>(p: ProviderConfig, method: string, params: unknown, o?: CallOptions): Promise<RpcObservation<T>> {
    const obs = await rpcCall<T>(p, method, params, {
      timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes,
      signal: o?.signal,
      fetch: this.fetchImpl,
    });
    this.metrics.record(obs);
    try {
      this.onObservation?.(obs);
    } catch {
      /* observer must not break inspection */
    }
    return obs;
  }

  private fanOut<T>(method: string, params: unknown | ((p: ProviderConfig) => unknown), o?: CallOptions, providers = this.providers) {
    return Promise.all(
      providers.map((p) => this.call<T>(p, method, typeof params === "function" ? (params as any)(p) : params, o)),
    );
  }

  /**
   * Read with failover across providers ordered by weight. Fails over ONLY on transport
   * failures and missing-history errors — never on deterministic answers. Safe for reads only;
   * the SDK never submits transactions.
   */
  async read<T = unknown>(method: string, params: unknown, o?: CallOptions): Promise<RpcObservation<T>[]> {
    const ordered = [...this.providers].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
    const trail: RpcObservation<T>[] = [];
    for (const p of ordered) {
      const obs = await this.call<T>(p, method, params, o);
      trail.push(obs);
      if (obs.ok) return trail;
      const retriable = obs.error && (obs.error.kind !== "RPC_ERROR" || isUnknownBlock(obs) || isUnknownTx(obs));
      if (!retriable || obs.error?.kind === "ABORTED") return trail;
    }
    return trail;
  }

  private async getValidityPeriod(o?: CallOptions): Promise<number> {
    if (this.validityPeriod) return this.validityPeriod;
    const trail = await this.read<any>("EXPERIMENTAL_protocol_config", { finality: "final" }, o);
    const last = trail[trail.length - 1];
    const v = last?.ok ? Number(last.result?.transaction_validity_period) : NaN;
    // Taken from one provider: never accept a value BELOW the protocol default (a lower value
    // would make an unexpired tx look expired). A higher value only makes Sentinel more cautious.
    if (Number.isFinite(v) && v > 0) this.validityPeriod = Math.max(v, DEFAULT_TX_VALIDITY_PERIOD);
    return this.validityPeriod ?? DEFAULT_TX_VALIDITY_PERIOD;
  }

  /**
   * Average block time measured from block timestamps over the last 1000 blocks (cached 10 min).
   * Used only for human-readable ETAs, never for safety decisions. Returns undefined if unmeasurable.
   */
  private blockTime?: { value: number; at: number };
  private async getBlockTimeSeconds(o?: CallOptions): Promise<number | undefined> {
    if (this.blockTime && Date.now() - this.blockTime.at < 10 * 60_000) return this.blockTime.value;
    const head = (await this.read<any>("block", { finality: "final" }, o)).at(-1);
    const h = head?.ok ? head.result?.header : undefined;
    if (!h) return undefined;
    const old = (await this.read<any>("block", { block_id: h.height - 1000 }, o)).at(-1);
    const oh = old?.ok ? old.result?.header : undefined;
    if (!oh || h.height === oh.height) return undefined;
    const secs = Number(BigInt(h.timestamp_nanosec) - BigInt(oh.timestamp_nanosec)) / 1e9 / (h.height - oh.height);
    if (!(secs > 0 && secs < 60)) return undefined;
    this.blockTime = { value: secs, at: Date.now() };
    return secs;
  }

  /* -------------------------------- inputs -------------------------------- */

  private resolve(input: InspectInput): ResolvedInput {
    const v = parseOrThrow(inspectInputSchema, input);
    if (v.signedTransactionBase64) {
      const d = decodeSignedTx(v.signedTransactionBase64);
      if (v.transactionHash && v.transactionHash !== d.hash) {
        throw new SentinelInputError(`transactionHash ${v.transactionHash} does not match the signed transaction (${d.hash})`);
      }
      if (!isValidAccountId(d.signerId)) throw new SentinelInputError("Signed transaction has an invalid signer");
      return { txHash: d.hash, signerId: d.signerId, nonce: d.nonce, publicKey: d.publicKey, blockHash: d.blockHash, fromSignedTx: true };
    }
    return {
      txHash: v.transactionHash!,
      signerId: v.senderAccountId!,
      nonce: v.nonce !== undefined ? BigInt(v.nonce) : undefined,
      publicKey: v.publicKey,
      blockHash: v.blockHash,
      fromSignedTx: false,
    };
  }

  /* ------------------------------ inspection ------------------------------ */

  /**
   * Inspect a transaction across all providers and return state, receipt graph,
   * evidence-backed diagnostics and a retry verdict.
   */
  async inspectTransaction(input: InspectInput, o?: CallOptions): Promise<InspectionResult> {
    const started = Date.now();
    const r = this.resolve(input);
    const observations: RpcObservation[] = [];
    const txParams = { tx_hash: r.txHash, sender_account_id: r.signerId, wait_until: "NONE" };

    // Phase 1: who has it? (wait_until NONE — never block; some providers hang on longer waits)
    const first = (await this.fanOut<RawTxStatusResult>("EXPERIMENTAL_tx_status", txParams, o)).map((x) => validateTxResult(x, r.txHash));
    observations.push(...first);
    let txObs = first;

    const anyFound = first.some((x) => x.ok);
    let perProvider: PerProviderRetryEvidence[] | undefined;
    let txBlockHeight: number | undefined;
    let validity = DEFAULT_TX_VALIDITY_PERIOD;
    let blockTimeSeconds: number | undefined;

    // Phase 2+3 (only when nobody has it and we know the nonce): read key nonce + window
    // coverage FIRST, then re-query tx status, so "not found" is observed after "nonce consumed".
    if (!anyFound && r.nonce !== undefined && r.publicKey) {
      [validity, blockTimeSeconds] = await Promise.all([this.getValidityPeriod(o), this.getBlockTimeSeconds(o)]);
      const [akObs, blockObs] = await Promise.all([
        this.fanOut<any>(
          "query",
          { request_type: "view_access_key", finality: "final", account_id: r.signerId, public_key: r.publicKey },
          o,
        ),
        r.blockHash ? this.fanOut<any>("block", { block_id: r.blockHash }, o) : Promise.resolve(undefined),
      ]);
      observations.push(...akObs, ...(blockObs ?? []));
      const second = (await this.fanOut<RawTxStatusResult>("EXPERIMENTAL_tx_status", txParams, o)).map((x) => validateTxResult(x, r.txHash));
      observations.push(...second);
      txObs = second;

      const archival = await Promise.all(this.providers.map((p) => this.isArchival(p, o)));
      // A block answer only counts if it is the block we asked for.
      const blockMatches = (b: RpcObservation<any> | undefined): boolean =>
        !!b?.ok && b.result?.header?.hash === r.blockHash && typeof b.result?.header?.height === "number";
      txBlockHeight = blockObs?.find(blockMatches)?.result?.header?.height;
      perProvider = this.providers.map((p, i) => {
        const ak = akObs[i]!;
        const tx = second[i]!;
        const blk = blockObs?.[i];
        // nearcore reports a missing key (or missing account) for view_access_key as a SUCCESSFUL
        // result carrying an `error` string — verified live 2026-11-09:
        //   {"result":{"block_hash":…,"block_height":…,"error":"access key ed25519:… does not exist while viewing","logs":[]}}
        // Newer structured errors (UNKNOWN_ACCESS_KEY) are handled too.
        const legacyErr = ak.ok && typeof ak.result?.error === "string" ? (ak.result.error as string) : undefined;
        const akMissing =
          (legacyErr !== undefined && /does not exist/i.test(legacyErr)) ||
          (!ak.ok && (ak.error?.causeName === "UNKNOWN_ACCESS_KEY" || /does not exist|UNKNOWN_ACCESS_KEY/i.test(ak.error?.message ?? "")));
        const akNonceRaw = ak.ok && legacyErr === undefined ? ak.result?.nonce : undefined;
        return {
          provider: p.name,
          operator: p.operator!,
          txLookup: tx.ok ? "FOUND" : isUnknownTx(tx) ? "NOT_FOUND" : "ERROR",
          accessKeyNonce: typeof akNonceRaw === "number" || typeof akNonceRaw === "string" ? BigInt(akNonceRaw) : undefined,
          accessKeyMissing: akMissing || undefined,
          observedFinalHeight: ak.ok ? ak.result?.block_height : undefined,
          txBlockHeight: blockMatches(blk) ? blk!.result.header.height : undefined,
          // With a block_hash: the provider covers the window iff it can return that block.
          // Without one: only a probed/declared archival node is assumed to hold all history.
          coversWindow: blk
            ? blk.ok
              ? blockMatches(blk)
                ? true
                : null
              : isUnknownBlock(blk)
                ? false
                : null
            : archival[i] === true
              ? true
              : null,
        } satisfies PerProviderRetryEvidence;
      });

      // Nonce-consumed proof needs a second, later "not found" from the same provider: a load-balanced pool can
      // serve the nonce read from an up-to-date backend and the lookup from a lagging one. If the re-check finds
      // the tx (or errors), that provider's answer no longer counts as proof — the verdict falls back to WAIT.
      const nonce = r.nonce;
      const candidates = perProvider.map((e) => e.txLookup === "NOT_FOUND" && e.accessKeyNonce !== undefined && e.accessKeyNonce >= nonce);
      if (candidates.some(Boolean)) {
        if (this.proofRecheckMs > 0) await new Promise((res) => setTimeout(res, this.proofRecheckMs));
        const recheck = (await this.fanOut<RawTxStatusResult>("EXPERIMENTAL_tx_status", txParams, o)).map((x) => validateTxResult(x, r.txHash));
        observations.push(...recheck);
        perProvider = perProvider.map((e, i) =>
          recheck[i]!.ok
            ? { ...e, txLookup: "FOUND", recheck: "FOUND" }
            : candidates[i] && !isUnknownTx(recheck[i]!)
              ? { ...e, txLookup: "ERROR", recheck: "ERROR" }
              : e,
        );
        // Positive evidence wins: any provider that now FINDS the tx feeds the found-path verdict
        // (DO_NOT_RETRY / WAIT / MANUAL_REVIEW), never SAFE_TO_RETRY.
        if (recheck.some((x) => x.ok)) txObs = second.map((x, i) => (recheck[i]!.ok ? recheck[i]! : x));
      }
    }

    // Aggregate found results.
    const verdicts: ProviderVerdict[] = this.providers.map((p, i) => {
      const x = txObs[i]!;
      if (x.ok && x.result) {
        const { nodes } = buildReceiptTree(x.result);
        return {
          provider: p.name,
          operator: p.operator!,
          outcome: "FOUND",
          finalExecutionStatus: x.result.final_execution_status,
          state: classifyFound(x.result, nodes).state,
          digest: outcomeDigest(x.result),
          latencyMs: x.latencyMs,
        };
      }
      return {
        provider: p.name,
        operator: p.operator!,
        outcome: isUnknownTx(x) ? "NOT_FOUND" : "ERROR",
        error: x.error,
        latencyMs: x.latencyMs,
      };
    });

    const foundObs = txObs.filter((x) => x.ok && x.result) as Array<RpcObservation<RawTxStatusResult> & { result: RawTxStatusResult }>;
    const best = foundObs.sort((a, b) => finalityRank(b.result.final_execution_status) - finalityRank(a.result.final_execution_status))[0];
    const bestDigest = best ? outcomeDigest(best.result) : undefined;

    const diagnostics: Diagnostic[] = diagnoseObservations(observations);
    let state: TxState = "UNKNOWN";
    let receiptTree: ReceiptNode | undefined;
    let receiptCount = 0;
    let gasBurntTotal = 0;
    let tokensBurntTotal = "0";
    let conflicting = false;
    let agreement: InspectionResult["agreement"];

    const executedDigests = new Set(verdicts.filter((v) => v.outcome === "FOUND" && v.state !== "INCLUDED").map((v) => v.digest));
    conflicting = executedDigests.size > 1;
    const answered = verdicts.filter((v) => v.outcome !== "ERROR");
    const notFound = verdicts.filter((v) => v.outcome === "NOT_FOUND");

    if (best) {
      const { root, nodes } = buildReceiptTree(best.result);
      const c = classifyFound(best.result, nodes);
      state = c.state;
      receiptTree = root;
      receiptCount = nodes.length;
      const t = totals(nodes, best.result);
      gasBurntTotal = t.gas;
      tokensBurntTotal = t.tokens;
      diagnostics.push(...diagnoseOutcome(c, r.txHash));
      if (conflicting) {
        diagnostics.push({
          code: "PROVIDER_DISAGREEMENT",
          title: "Providers report different execution outcomes",
          confidence: "high",
          explanation: "At least two providers returned executed outcomes with different status/receipt digests. This is not explainable by lag.",
          evidence: verdicts
            .filter((v) => v.outcome === "FOUND")
            .map((v) => ({ claim: `${v.provider}: state=${v.state} digest=${v.digest}`, provider: v.provider })),
          suggestedAction: "Do not act on this transaction automatically. Verify with an archival node you operate.",
          retry: "unknown",
        });
      } else if (notFound.length > 0) {
        diagnostics.push({
          code: "PROVIDER_DISAGREEMENT",
          title: `${plural(notFound.length, "provider")} ${notFound.length === 1 ? "does" : "do"} not have a transaction others have`,
          confidence: "medium",
          explanation:
            "Positive evidence wins: the transaction exists. Missing it on some providers is consistent with indexing lag or garbage-collected history on non-archival nodes — not with misbehaviour. This alone is not a reason to distrust a provider.",
          evidence: notFound.map((v) => ({ claim: `${v.provider} answered UNKNOWN_TRANSACTION`, provider: v.provider })),
          suggestedAction: "No action needed for this transaction.",
          retry: "unknown",
        });
      }
      agreement = conflicting
        ? "CONFLICTING"
        : notFound.length === 0 && new Set(verdicts.filter((v) => v.outcome === "FOUND").map((v) => v.digest)).size === 1
          ? "UNANIMOUS"
          : "CONSISTENT_WITH_LAG";
    } else {
      agreement = answered.length === 0 ? "INSUFFICIENT" : "UNANIMOUS";
      if (notFound.length) diagnostics.push(notFoundDiagnostic(txObs, (perProvider ?? []).filter((p) => p.coversWindow).map((p) => p.provider)));
      if (answered.length === 0) {
        diagnostics.push({
          code: "INCOMPLETE_EVIDENCE",
          title: "No provider answered",
          confidence: "high",
          explanation: "Every provider failed at the transport level. Nothing can be concluded about this transaction.",
          evidence: [],
          suggestedAction: "Retry the inspection later or configure additional providers.",
          retry: "unknown",
        });
      }
      if (perProvider && !perProvider.some((p) => p.coversWindow === true)) {
        diagnostics.push({
          code: "HISTORY_NOT_COVERED",
          title: "No provider proved it holds the history window for this transaction",
          confidence: "medium",
          explanation:
            "None of the providers returned the transaction's reference block, so their 'not found' answers may simply reflect garbage-collected history.",
          evidence: [],
          suggestedAction: "Add an archival RPC provider.",
          retry: "unknown",
        });
      }
    }

    const retryRecommendation: RetryRecommendation = decideRetry({
      txHash: r.txHash,
      found: best
        ? {
            state,
            conflicting,
            finalFailureOperators: new Set(
              verdicts
                .filter((v) => v.outcome === "FOUND" && v.state === "EXECUTED_FAILURE" && v.finalExecutionStatus === "FINAL" && v.digest === bestDigest)
                .map((v) => v.operator),
            ).size,
          }
        : undefined,
      fieldsFromSignedTx: r.fromSignedTx,
      txNonce: r.nonce,
      txBlockHash: r.blockHash,
      txBlockHeight,
      validityPeriod: validity,
      minIndependentOperators: this.minOps,
      blockTimeSeconds,
      providers:
        perProvider ??
        verdicts.map((v) => ({
          provider: v.provider,
          operator: v.operator,
          txLookup: v.outcome,
          coversWindow: null,
        })),
    });

    if (!best && retryRecommendation.verdict === "SAFE_TO_RETRY") state = "EXPIRED_OR_UNRESOLVED";

    return {
      txHash: r.txHash,
      senderAccountId: r.signerId,
      network: this.network,
      state,
      finalExecutionStatus: best?.result.final_execution_status,
      finalized: best?.result.final_execution_status === "FINAL",
      transaction: best ? summarizeTransaction(best.result) : undefined,
      receiptTree,
      receiptCount,
      gasBurntTotal,
      tokensBurntTotal,
      includedInBlockHash: best?.result.transaction_outcome.block_hash,
      providers: verdicts,
      agreement,
      diagnostics,
      retryRecommendation,
      observations,
      inspectedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    };
  }

  /** Retry verdict with the evidence it was based on. Alias of inspectTransaction focused on the decision. */
  async checkRetrySafety(input: InspectInput, o?: CallOptions) {
    const i = await this.inspectTransaction(input, o);
    return {
      txHash: i.txHash,
      state: i.state,
      verdict: i.retryRecommendation.verdict,
      recommendation: i.retryRecommendation,
      diagnostics: i.diagnostics,
      inspection: i,
    };
  }

  /**
   * Ask every provider what a deployed Sentinel Guard contract has recorded for (payerId, intentId).
   * Read-only view call (`get_intent`); positive evidence wins and disagreement is surfaced.
   */
  async checkIntent(input: IntentInput, o?: CallOptions): Promise<IntentCheck> {
    const v = parseOrThrow(intentInputSchema, input);
    const args = Buffer.from(JSON.stringify({ payer_id: v.payerId, intent_id: v.intentId })).toString("base64");
    const obs = await this.fanOut<any>(
      "query",
      { request_type: "call_function", finality: "final", account_id: v.contractId, method_name: "get_intent", args_base64: args },
      o,
    );
    const answers: IntentProviderAnswer[] = this.providers.map((p, i) => {
      const x = obs[i]!;
      const d = decodeViewResult(x);
      const base = { provider: p.name, operator: p.operator!, latencyMs: x.latencyMs, blockHeight: x.ok ? x.result?.block_height : undefined };
      if (d.kind === "error") return { ...base, answer: "ERROR", error: d.message };
      if (d.value === null) return { ...base, answer: "NOT_RECORDED" };
      return isGuardIntent(d.value, v)
        ? { ...base, answer: "RECORDED", intent: d.value }
        : { ...base, answer: "ERROR", error: "unexpected get_intent answer (not a Sentinel Guard record for this intent)" };
    });
    return { ...decideIntent(v, answers), checkedAt: new Date().toISOString() };
  }

  /**
   * How much may this agent spend right now from a Sentinel Vault allowance? Read-only `get_policy` view call
   * on every provider; reports the smallest available amount any provider shows (never overstates it).
   */
  async checkSpendAllowance(input: VaultInput, o?: CallOptions): Promise<AllowanceCheck> {
    const v = parseOrThrow(vaultInputSchema, input);
    const args = Buffer.from(JSON.stringify({ owner_id: v.ownerId, agent_id: v.agentId })).toString("base64");
    const obs = await this.fanOut<any>(
      "query",
      { request_type: "call_function", finality: "final", account_id: v.contractId, method_name: "get_policy", args_base64: args },
      o,
    );
    const answers = this.providers.map((p, i) =>
      vaultAnswer({ provider: p.name, operator: p.operator!, latencyMs: obs[i]!.latencyMs, blockHeight: obs[i]!.ok ? obs[i]!.result?.block_height : undefined }, obs[i]!, v),
    );
    const decided = decideAllowance(v, answers);
    return { ...decided, checkedAt: new Date().toISOString(), ...(decided.policy ? { safety: assessAllowanceSafety(decided.policy) } : {}) };
  }

  /**
   * Can this agent's keys drain its account? Read-only `view_access_key_list` on every provider; grades each key
   * (full access = critical) and returns near-cli-rs setup commands with placeholders for a least-privilege key.
   */
  async auditAgentKeys(input: KeyAuditInput, o?: CallOptions): Promise<KeyAudit> {
    const v = parseOrThrow(keyAuditInputSchema, input);
    // view_account runs alongside: nearcore lists `keys: []` for a missing account, so it tells NO_KEYS from ACCOUNT_NOT_FOUND.
    const [obs, acct] = await Promise.all([
      this.fanOut<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: v.accountId }, o),
      this.fanOut<any>("query", { request_type: "view_account", finality: "final", account_id: v.accountId }, o),
    ]);
    const answers = this.providers.map((p, i) => keyListAnswer({ provider: p.name, operator: p.operator!, latencyMs: obs[i]!.latencyMs }, obs[i]!, acct[i]!));
    return { ...decideKeyAudit({ ...v, network: this.network }, answers), checkedAt: new Date().toISOString() };
  }

  /** `view_account` for the receiver on every provider, decoded. */
  private async receiverObservations(receiverId: string, o?: CallOptions): Promise<ReceiverProviderObservation[]> {
    const obs = await this.fanOut<any>("query", { request_type: "view_account", finality: "final", account_id: receiverId }, o);
    return this.providers.map((p, i) => receiverAnswer({ provider: p.name, operator: p.operator!, latencyMs: obs[i]!.latencyMs }, obs[i]!));
  }

  /**
   * Is this payee who the agent thinks it is? Flags lookalikes of the known receivers (named technique) and address
   * poisoning, and reads `view_account` on every provider (exists, contract). Call before paying anyone new. Read-only.
   */
  async checkReceiver(input: ReceiverCheckInput, o?: CallOptions): Promise<ReceiverCheck> {
    const v = parseOrThrow(receiverCheckInputSchema, input);
    return { ...decideReceiver(v, await this.receiverObservations(v.receiverId, o)), checkedAt: new Date().toISOString() };
  }

  /**
   * Would the Vault accept this spend right now? Reads the allowance (get_policy) and, with an intentId,
   * `get_spend` on every provider, then mirrors the contract's checks in order. Advisory: the contract is the
   * final judge. Never signs or submits anything.
   */
  async preflightSpend(input: PreflightInput, o?: CallOptions): Promise<SpendPreflight> {
    const v = parseOrThrow(preflightInputSchema, input);
    const vault = { contractId: v.contractId, ownerId: v.ownerId, agentId: v.agentId };
    const spendObs = v.intentId
      ? this.fanOut<any>(
          "query",
          {
            request_type: "call_function",
            finality: "final",
            account_id: v.contractId,
            method_name: "get_spend",
            args_base64: Buffer.from(JSON.stringify({ owner_id: v.ownerId, agent_id: v.agentId, intent_id: v.intentId })).toString("base64"),
          },
          o,
        )
      : Promise.resolve(undefined);
    // The receiver's view_account runs in parallel; the known list (allowlist + owner) is applied once the policy is in.
    const receiverObs = this.receiverObservations(v.receiverId, o).catch(() => undefined);
    const [allowance, spends, rObs] = await Promise.all([this.checkSpendAllowance(vault, o), spendObs, receiverObs]);
    let duplicate: boolean | undefined;
    if (spends) {
      const decoded = spends.map((x) => decodeViewResult(x));
      const answered = decoded.filter((d) => d.kind === "value");
      if (answered.some((d) => d.value !== null)) duplicate = true;
      // "Not used" needs more than one possibly stale answer: every provider, or at least two, must say so.
      else if (answered.length >= 2 || (answered.length > 0 && answered.length === decoded.length)) duplicate = false;
    }
    const decided = decideSpendPreflight(allowance, { receiverId: v.receiverId, amount: v.amountYocto, intentId: v.intentId, duplicate });
    let receiverCheck: ReceiverCheck | undefined;
    if (rObs) {
      // Every allowlist entry plus the owner (the contract bounds the allowlist at 20, so at most 21): the public
      // input cap of 20 does not apply here, so a lookalike of the last entry is still caught.
      const known = [...new Set([...(allowance.policy?.allowed_receivers ?? []), v.ownerId])].filter(isValidAccountId);
      receiverCheck = { ...decideReceiver({ receiverId: v.receiverId, knownReceivers: known }, rObs), checkedAt: new Date().toISOString() };
    }
    const rc = receiverCheck;
    const warn =
      decided.decision === "ALLOWED" &&
      rc &&
      (rc.status === "DANGER" || rc.status === "NOT_FOUND" || (rc.status === "WARNING" && rc.findings.some((f) => f.title === PROVIDERS_DISAGREE_TITLE)))
        ? ` Warning: receiver check says ${rc.status}: ${rc.reason}`
        : "";
    return { ...decided, reason: decided.reason + warn, ...(receiverCheck ? { receiverCheck } : {}), checkedAt: new Date().toISOString() };
  }

  /** Receipt execution graph for a transaction (undefined when no provider has it). */
  async traceReceipts(input: InspectInput, o?: CallOptions): Promise<{ root?: ReceiptNode; state: TxState; inspection: InspectionResult }> {
    const i = await this.inspectTransaction(input, o);
    return { root: i.receiptTree, state: i.state, inspection: i };
  }

  /**
   * Diagnose either an error you received when submitting (no network calls),
   * or a transaction by hash (full inspection).
   */
  async diagnoseFailure(input: { error: unknown } | InspectInput, o?: CallOptions): Promise<Diagnostic[]> {
    if (input && typeof input === "object" && "error" in input) return [diagnoseSubmissionError(input.error)];
    return (await this.inspectTransaction(input as InspectInput, o)).diagnostics;
  }

  /**
   * Send the same read-only request to every provider and group identical answers.
   * Only allow-listed read methods are accepted.
   */
  async compareProviders(req: { method: string; params: unknown }, o?: CallOptions): Promise<CompareResult> {
    const allowed = new Set([
      "status",
      "block",
      "chunk",
      "query",
      "EXPERIMENTAL_tx_status",
      "tx",
      "EXPERIMENTAL_receipt",
      "EXPERIMENTAL_protocol_config",
      "gas_price",
      "validators",
    ]);
    if (!allowed.has(req.method)) throw new SentinelInputError(`Method ${req.method} is not an allow-listed read method`);
    const obs = await this.fanOut<unknown>(req.method, req.params, o);
    const groups = new Map<string, { digest: string; providers: string[]; sample: unknown }>();
    for (const x of obs) {
      if (!x.ok) continue;
      const digest = stableStringify(x.result);
      const key = digest.length > 64 ? `${digest.length}:${hashStr(digest)}` : digest;
      const g = groups.get(key) ?? { digest: key, providers: [], sample: x.result };
      g.providers.push(x.provider);
      groups.set(key, g);
    }
    const errors = obs.filter((x) => !x.ok).map((x) => ({ provider: x.provider, error: x.error }));
    return {
      method: req.method,
      params: req.params,
      groups: [...groups.values()],
      errors,
      agreement: groups.size === 0 ? "INSUFFICIENT" : groups.size === 1 ? "UNANIMOUS" : "SPLIT",
      observations: obs,
    };
  }

  private async isArchival(p: ProviderConfig, o?: CallOptions): Promise<boolean | null> {
    if (p.archival !== undefined) return p.archival;
    const cached = this.archivalCache.get(p.name);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const net = this.network === "mainnet" ? "mainnet" : "testnet";
    const b = await this.call<any>(p, "block", { block_id: ARCHIVAL_PROBE_HEIGHT[net] }, o);
    const value = b.ok ? true : isUnknownBlock(b) ? false : null;
    this.archivalCache.set(p.name, { value, at: Date.now() });
    return value;
  }

  /** Probe every provider: liveness, height lag, latency and capabilities (tested, not self-reported). */
  async getProviderHealth(opts: { capabilities?: boolean } & CallOptions = {}): Promise<ProviderHealth[]> {
    const withCaps = opts.capabilities ?? true;
    const results = await Promise.all(
      this.providers.map(async (p): Promise<ProviderHealth> => {
        const observations: RpcObservation[] = [];
        const st = await this.call<any>(p, "status", [], opts);
        observations.push(st);
        const caps: ProviderHealth["capabilities"] = {
          archival: null,
          supportsTxMethod: null,
          supportsTxStatusMethod: null,
          supportsExperimentalTxStatus: null,
          supportsExperimentalReceipt: null,
        };
        if (st.ok && withCaps) {
          const probeTx = { tx_hash: NULL_HASH, sender_account_id: "near", wait_until: "NONE" };
          const [tx, txs, etx, rcpt, archival] = await Promise.all([
            this.call(p, "tx", probeTx, opts),
            this.call(p, "tx_status", probeTx, opts),
            this.call(p, "EXPERIMENTAL_tx_status", probeTx, opts),
            this.call(p, "EXPERIMENTAL_receipt", { receipt_id: NULL_HASH }, opts),
            this.isArchival(p, opts),
          ]);
          observations.push(tx, txs, etx, rcpt);
          // A method is supported if the provider answered with anything other than "method not found"
          // (UNKNOWN_TRANSACTION for the null hash is the expected answer). Transport failures → unknown.
          const supported = (x: RpcObservation): boolean | null =>
            isMethodNotFound(x) ? false : x.ok || x.error?.kind === "RPC_ERROR" ? true : null;
          caps.supportsTxMethod = supported(tx);
          caps.supportsTxStatusMethod = supported(txs);
          caps.supportsExperimentalTxStatus = supported(etx);
          caps.supportsExperimentalReceipt = supported(rcpt);
          caps.archival = archival;
        }
        const si = st.result?.sync_info;
        return {
          provider: p.name,
          operator: p.operator!,
          url: p.url,
          reachable: st.ok,
          chainId: st.result?.chain_id,
          latestBlockHeight: si?.latest_block_height,
          syncing: si?.syncing,
          protocolVersion: st.result?.protocol_version,
          latencyMs: st.latencyMs,
          reportedEarliestBlockHeight: si?.earliest_block_height,
          capabilities: caps,
          error: st.error,
          checkedAt: st.observedAt,
          observations,
        };
      }),
    );
    const maxH = Math.max(...results.map((r) => r.latestBlockHeight ?? 0));
    for (const r of results) if (r.latestBlockHeight !== undefined) r.heightLag = maxH - r.latestBlockHeight;
    return results;
  }

  getProviderMetrics(): ProviderMetrics[] {
    return this.metrics.snapshot();
  }

  /**
   * Poll a transaction until it reaches a terminal, final state (or the deadline).
   * Yields every inspection whose state/finality changed.
   */
  async *subscribeToTransaction(
    input: InspectInput,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<InspectionResult, void, void> {
    const interval = Math.max(1000, opts.intervalMs ?? 2000);
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let lastKey = "";
    while (!opts.signal?.aborted) {
      const i = await this.inspectTransaction(input, { signal: opts.signal });
      const key = `${i.state}|${i.finalExecutionStatus}|${i.retryRecommendation.verdict}`;
      if (key !== lastKey) {
        lastKey = key;
        yield i;
      }
      const terminal = i.finalized && i.state !== "INCLUDED";
      if (terminal || i.state === "EXPIRED_OR_UNRESOLVED" || Date.now() + interval > deadline) return;
      await new Promise<void>((res) => {
        const t = setTimeout(res, interval);
        opts.signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
      });
    }
  }

  /** Self-describing JSON report (stable schema) for storage, sharing or attaching to incidents. */
  exportDiagnosticReport(inspection: InspectionResult): DiagnosticReport {
    return {
      schema: "near-sentinel/diagnostic-report@1",
      generatedAt: new Date().toISOString(),
      generator: { name: "@near-sentinel/sdk", version: SDK_VERSION },
      network: inspection.network,
      inspection: JSON.parse(JSON.stringify(inspection, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    };
  }
}

function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
