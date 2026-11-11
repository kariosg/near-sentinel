/**
 * Public types for @near-sentinel/sdk.
 *
 * Design rule: every conclusion carries the evidence (raw provider observations)
 * it was derived from. "Unknown" is a first-class answer and is never coerced
 * into "safe".
 */

export type Network = "mainnet" | "testnet" | "custom";

export type Finality = "optimistic" | "near-final" | "final";

/** nearcore `TxExecutionStatus` (wait_until / final_execution_status). Verbatim protocol values. */
export type TxExecutionStatus =
  | "NONE"
  | "INCLUDED"
  | "EXECUTED_OPTIMISTIC"
  | "INCLUDED_FINAL"
  | "EXECUTED"
  | "FINAL";

export interface ProviderConfig {
  /** Unique display name, e.g. "fastnear". */
  name: string;
  /** JSON-RPC endpoint URL. */
  url: string;
  /**
   * Who operates the node. Two providers with the same operator are NOT
   * independent witnesses. Defaults to the URL hostname's registrable part.
   */
  operator?: string;
  /** Known to keep full history. `undefined` = unknown (probed at runtime). */
  archival?: boolean;
  /** Extra HTTP headers (e.g. API keys). Never logged. */
  headers?: Record<string, string>;
  /** Relative weight for read routing. Default 1. */
  weight?: number;
}

/** Why a single RPC call did not produce a usable `result`. */
export type RpcFailureKind =
  | "TIMEOUT" // client-side deadline hit, no response
  | "NETWORK" // connection refused/reset/DNS
  | "RATE_LIMITED" // HTTP 429 or JSON-RPC -429
  | "HTTP_ERROR" // non-2xx without a parseable JSON-RPC error
  | "MALFORMED" // body not JSON / not JSON-RPC
  | "TOO_LARGE" // body exceeded maxResponseBytes
  | "RPC_ERROR" // well-formed JSON-RPC error object
  | "ABORTED"; // caller cancelled

export interface RpcErrorInfo {
  kind: RpcFailureKind;
  /** nearcore error `name` e.g. HANDLER_ERROR, REQUEST_VALIDATION_ERROR */
  name?: string;
  /** nearcore `cause.name` e.g. UNKNOWN_TRANSACTION, TIMEOUT_ERROR */
  causeName?: string;
  causeInfo?: unknown;
  code?: number;
  message: string;
  data?: unknown;
}

/** One request to one provider, exactly as observed. This is the unit of evidence. */
export interface RpcObservation<T = unknown> {
  provider: string;
  operator: string;
  url: string;
  method: string;
  params: unknown;
  ok: boolean;
  result?: T;
  error?: RpcErrorInfo;
  httpStatus?: number;
  latencyMs: number;
  /** ISO timestamp when the request started. */
  observedAt: string;
}

/* ----------------------------- transaction model ----------------------------- */

/**
 * Application-level states. Mapped from real RPC responses; see docs/architecture/STATE_MAPPING.md.
 * CREATED / SUBMITTED are deliberately absent: a read-only observer cannot see them.
 */
export type TxState =
  /** No provider has the tx and we cannot prove it will never land. */
  | "UNKNOWN"
  /** Included in a chunk; some receipts not yet executed. */
  | "INCLUDED"
  /** Every receipt executed and none failed. */
  | "EXECUTED_SUCCESS"
  /** Every non-refund receipt failed; no observable side effects beyond gas. */
  | "EXECUTED_FAILURE"
  /** Mixed: some receipts succeeded and some failed (multi-contract workflow incomplete). */
  | "PARTIALLY_COMPLETED"
  /** Not found by any covering provider AND provably can never be included (nonce used / expired). */
  | "EXPIRED_OR_UNRESOLVED";

export type ReceiptStatus = "SUCCESS" | "FAILURE" | "PENDING";

export interface ReceiptAction {
  type: string;
  methodName?: string;
  deposit?: string;
  gas?: string | number;
  /** Small human summary; args are not decoded beyond base64 length. */
  summary?: string;
}

export interface ReceiptNode {
  receiptId: string;
  /** Account that executed the receipt. */
  executorId: string;
  predecessorId?: string;
  /** true for gas/deposit refunds issued by "system". */
  isRefund: boolean;
  status: ReceiptStatus;
  /** Raw nearcore status object (SuccessValue / SuccessReceiptId / Failure / Unknown). */
  rawStatus: unknown;
  failure?: ExecutionFailure;
  actions: ReceiptAction[];
  gasBurnt: number;
  tokensBurnt: string;
  logs: string[];
  blockHash: string;
  children: ReceiptNode[];
  /** Depth in the execution graph, root = 0. */
  depth: number;
}

export interface ExecutionFailure {
  /** Flattened path of the nearcore error enum, e.g. ["ActionError","FunctionCallError","ExecutionError"]. */
  path: string[];
  message: string;
  raw: unknown;
}

export interface TransactionSummary {
  hash: string;
  signerId: string;
  receiverId: string;
  publicKey: string;
  nonce: string;
  actions: ReceiptAction[];
}

/* ------------------------------- diagnostics -------------------------------- */

export type DiagnosticCode =
  | "RPC_TIMEOUT"
  | "RATE_LIMITED"
  | "NETWORK_UNAVAILABLE"
  | "MALFORMED_RESPONSE"
  | "SUBMISSION_REJECTED"
  | "INVALID_TRANSACTION"
  | "INVALID_NONCE"
  | "INSUFFICIENT_BALANCE"
  | "TRANSACTION_EXPIRED"
  | "GAS_EXHAUSTED"
  | "CONTRACT_EXECUTION_FAILURE"
  | "RECEIPT_EXECUTION_FAILURE"
  | "DOWNSTREAM_FAILURE_MASKED"
  | "RECEIPTS_PENDING"
  | "TX_NOT_FOUND"
  | "HISTORY_NOT_COVERED"
  | "PROVIDER_DISAGREEMENT"
  | "INCOMPLETE_EVIDENCE"
  | "UNKNOWN_FAILURE";

export type Confidence = "high" | "medium" | "low";

export type RetrySafety = "safe" | "unsafe" | "unknown";

export interface EvidenceRef {
  /** What this evidence shows, in one sentence. */
  claim: string;
  provider?: string;
  method?: string;
  /** Pointer into the observation list (index) when applicable. */
  observationIndex?: number;
  receiptId?: string;
  txHash?: string;
  /** Small excerpt of the raw value backing the claim. */
  excerpt?: unknown;
}

export interface Diagnostic {
  code: DiagnosticCode;
  title: string;
  confidence: Confidence;
  explanation: string;
  evidence: EvidenceRef[];
  suggestedAction: string;
  retry: RetrySafety;
}

/* ------------------------------- retry safety ------------------------------- */

export type RetryVerdict =
  | "SAFE_TO_RETRY"
  | "DO_NOT_RETRY"
  | "WAIT_AND_RECHECK"
  | "MANUAL_REVIEW_REQUIRED";

export interface RetryCheck {
  /** Name of the check, e.g. "tx-found-anywhere". */
  id: string;
  passed: boolean | null; // null = could not be evaluated
  detail: string;
}

export interface RetryRecommendation {
  verdict: RetryVerdict;
  confidence: Confidence;
  /** One-paragraph reason a human or an LLM agent can act on. */
  reason: string;
  /**
   * The concrete next step. When the tx may still land, this tells the caller
   * to re-broadcast the IDENTICAL signed tx (idempotent) instead of re-signing.
   */
  nextAction: string;
  /** Re-broadcasting the identical signed transaction is always duplicate-safe on NEAR. */
  rebroadcastSameSignedTxIsSafe: boolean;
  /** Seconds after which re-checking may change the answer (WAIT_AND_RECHECK). */
  recheckAfterSeconds?: number;
  checks: RetryCheck[];
}

/* ------------------------------ provider health ----------------------------- */

export interface ProviderCapabilities {
  /** Serves blocks far older than the GC window (probed, not self-reported). */
  archival: boolean | null;
  /** Accepts the `tx` method. */
  supportsTxMethod: boolean | null;
  /** Accepts `tx_status` (stabilised in nearcore 2.14; dRPC testnet rejects it as of 2026-11-09). */
  supportsTxStatusMethod: boolean | null;
  supportsExperimentalTxStatus: boolean | null;
  supportsExperimentalReceipt: boolean | null;
}

export interface ProviderHealth {
  provider: string;
  operator: string;
  url: string;
  reachable: boolean;
  chainId?: string;
  latestBlockHeight?: number;
  /** Blocks behind the highest height seen across providers in the same probe. */
  heightLag?: number;
  syncing?: boolean;
  protocolVersion?: number;
  latencyMs: number;
  /** Self-reported earliest block. Unreliable (see docs) — shown, never trusted. */
  reportedEarliestBlockHeight?: number;
  capabilities: ProviderCapabilities;
  error?: RpcErrorInfo;
  checkedAt: string;
  observations: RpcObservation[];
}

/* --------------------------------- results ---------------------------------- */

export interface ProviderVerdict {
  provider: string;
  operator: string;
  outcome: "FOUND" | "NOT_FOUND" | "ERROR";
  finalExecutionStatus?: TxExecutionStatus;
  state?: TxState;
  /** Stable digest of (status, receipt ids, receipt statuses) for agreement checks. */
  digest?: string;
  error?: RpcErrorInfo;
  latencyMs: number;
}

export interface InspectionResult {
  txHash: string;
  senderAccountId: string;
  network: string;
  state: TxState;
  /** Highest finality any provider reported for this tx. */
  finalExecutionStatus?: TxExecutionStatus;
  /** true when the outcome is FINAL (irreversible). */
  finalized: boolean;
  transaction?: TransactionSummary;
  /** Root of the receipt execution graph (first receipt). */
  receiptTree?: ReceiptNode;
  receiptCount: number;
  gasBurntTotal: number;
  tokensBurntTotal: string;
  /** Block hash that included the transaction (from transaction_outcome). */
  includedInBlockHash?: string;
  providers: ProviderVerdict[];
  agreement: "UNANIMOUS" | "CONSISTENT_WITH_LAG" | "CONFLICTING" | "INSUFFICIENT";
  diagnostics: Diagnostic[];
  retryRecommendation: RetryRecommendation;
  /** Raw evidence. Every claim above refers back here. */
  observations: RpcObservation[];
  inspectedAt: string;
  durationMs: number;
}

export interface DiagnosticReport {
  schema: "near-sentinel/diagnostic-report@1";
  generatedAt: string;
  generator: { name: "@near-sentinel/sdk"; version: string };
  network: string;
  inspection: InspectionResult;
}
