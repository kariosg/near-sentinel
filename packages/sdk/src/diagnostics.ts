/**
 * Deterministic diagnostic engine. Rules only — no LLM, no heuristics that cannot
 * cite the observation or receipt they came from.
 */
import type { Classification } from "./outcome.js";
import { plural } from "./text.js";
import { isTimeout, isUnknownTx } from "./rpc.js";
import type { Diagnostic, DiagnosticCode, EvidenceRef, ReceiptNode, RetrySafety, RpcObservation } from "./types.js";

/* ------------------------------ helpers ------------------------------ */

/** Depth-first search for the first object key from `keys` anywhere inside `v`. */
export function findKey(v: unknown, keys: string[], depth = 0): { key: string; value: unknown } | undefined {
  if (!v || typeof v !== "object" || depth > 10) return undefined;
  for (const k of Object.keys(v as object)) {
    if (keys.includes(k)) return { key: k, value: (v as any)[k] };
  }
  for (const k of Object.keys(v as object)) {
    const hit = findKey((v as any)[k], keys, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

const containsString = (v: unknown, re: RegExp): boolean => re.test(typeof v === "string" ? v : JSON.stringify(v ?? ""));

/**
 * nearcore TIMEOUT_ERROR causes (nearcore PR #15950, live on testnet/mainnet 2.14; documented at
 * https://docs.near.org/api/rpc/transactions). Observed live 2026-11-09: NOT_OBSERVED.
 */
export const TIMEOUT_CAUSE_MEANING: Record<string, string> = {
  NOT_OBSERVED: "this node had not seen the transaction when its deadline expired (not yet propagated, dropped, or never received)",
  PENDING: "this node has seen the transaction but it has not finished executing",
  ERROR: "the node hit an internal error while waiting",
};

/** Extract `cause.info.cause` from a TIMEOUT_ERROR (raw JSON-RPC error or our RpcErrorInfo). */
export function timeoutCause(err: unknown): string | undefined {
  const info = (err as any)?.causeInfo ?? (err as any)?.cause?.info ?? findKey(err, ["TIMEOUT_ERROR"])?.value;
  const c = (info as any)?.cause;
  if (typeof c === "string") return c;
  const deep = findKey(err, ["info"])?.value as any;
  return typeof deep?.cause === "string" ? deep.cause : undefined;
}

/* -------------------------- execution failures -------------------------- */

const GAS_KEYS = ["GasExceeded", "GasLimitExceeded", "GasInstrumentation"];
const BALANCE_KEYS = ["LackBalanceForState", "NotEnoughBalance", "NotEnoughAllowance", "InsufficientStake", "TriesToUnstake"];
const ACCOUNT_KEYS = ["AccountDoesNotExist", "AccountAlreadyExists", "ActorNoPermission", "CreateAccountNotAllowed", "OnlyImplicitAccountCreationAllowed"];

function classifyReceiptFailure(n: ReceiptNode): { code: DiagnosticCode; title: string; action: string } {
  const raw = n.failure?.raw;
  if (findKey(raw, GAS_KEYS) || containsString(raw, /Exceeded the prepaid gas|GasLimitExceeded/i)) {
    return {
      code: "GAS_EXHAUSTED",
      title: `Receipt on ${n.executorId} ran out of gas`,
      action: "Attach more gas (max 300 Tgas per transaction) or split the work. Re-signing with the same gas fails the same way.",
    };
  }
  const bal = findKey(raw, BALANCE_KEYS);
  if (bal) {
    return {
      code: "INSUFFICIENT_BALANCE",
      title: `${bal.key} on ${n.executorId}`,
      action: bal.key === "LackBalanceForState"
        ? "The account cannot cover storage staking. Top it up or free storage, then retry."
        : "Top up the paying account, then retry.",
    };
  }
  const acc = findKey(raw, ACCOUNT_KEYS);
  if (acc) {
    return {
      code: "RECEIPT_EXECUTION_FAILURE",
      title: `${acc.key} while executing on ${n.executorId}`,
      action: "Fix the account precondition (wrong receiver, missing account, permissions) before retrying.",
    };
  }
  if (findKey(raw, ["FunctionCallError"])) {
    return {
      code: "CONTRACT_EXECUTION_FAILURE",
      title: `Contract ${n.executorId} failed${n.actions[0]?.methodName ? ` in ${n.actions[0].methodName}()` : ""}`,
      action: "The contract rejected the call. Read the panic message; retrying unchanged will most likely fail identically.",
    };
  }
  return {
    code: "RECEIPT_EXECUTION_FAILURE",
    title: `Receipt failed on ${n.executorId}`,
    action: "Inspect the raw failure below.",
  };
}

export function diagnoseOutcome(c: Classification, txHash: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const multi = c.failed.length > 0 && c.succeeded.length > 0;

  for (const n of c.failed) {
    const k = classifyReceiptFailure(n);
    const isRoot = n.depth === 0;
    out.push({
      code: !isRoot && k.code === "CONTRACT_EXECUTION_FAILURE" ? "RECEIPT_EXECUTION_FAILURE" : k.code,
      title: isRoot ? k.title : `Downstream: ${k.title}`,
      confidence: "high",
      explanation:
        `Receipt ${n.receiptId} (depth ${n.depth}) executed on ${n.executorId} and returned Failure: ` +
        `${(n.failure?.message ?? "(no message)").replace(/\.+$/, "")}.` +
        (multi ? " Other receipts in this transaction SUCCEEDED, so state changes may have been applied partially." : ""),
      evidence: [
        {
          claim: `Receipt outcome status is Failure (${(n.failure?.path ?? []).join(" › ")})`,
          receiptId: n.receiptId,
          txHash,
          excerpt: n.failure?.raw,
        },
      ],
      suggestedAction: multi
        ? `${k.action} Because part of the workflow already executed, check the contract state of ${[...new Set(c.succeeded.map((s) => s.executorId))].join(", ")} before any retry.`
        : k.action,
      retry: multi ? "unsafe" : "safe",
    });
  }

  if (c.downstreamFailureMasked) {
    out.push({
      code: "DOWNSTREAM_FAILURE_MASKED",
      title: "Top-level status is success, but a downstream receipt failed",
      confidence: "high",
      explanation:
        "The transaction's final status is a success value, yet at least one cross-contract receipt failed. " +
        "A callback most likely handled (or swallowed) the error. Explorers and SDKs that only check the top-level status will report this as fully successful.",
      evidence: c.failed.map((n) => ({
        claim: `Receipt on ${n.executorId} failed: ${n.failure?.message ?? ""}`,
        receiptId: n.receiptId,
        txHash,
      })),
      suggestedAction: "Verify the application-level result (e.g. token balances, contract view methods) before treating the operation as done.",
      retry: "unsafe",
    });
  }

  if (c.pending.length > 0) {
    out.push({
      code: "RECEIPTS_PENDING",
      title: `${plural(c.pending.length, "receipt")} not executed yet`,
      confidence: "high",
      explanation:
        "The transaction is included in the chain, but some receipts have not executed. Cross-shard receipts usually execute within a few blocks.",
      evidence: c.pending.map((n) => ({ claim: "Outcome status is Unknown / not yet present", receiptId: n.receiptId, txHash })),
      suggestedAction: "Do not re-sign. Wait a few seconds and re-check.",
      retry: "unsafe",
    });
  }
  return out;
}

/* ------------------------ observation-level issues ------------------------ */

export function diagnoseObservations(obs: RpcObservation[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const ref = (o: RpcObservation, i: number, claim: string): EvidenceRef => ({
    claim,
    provider: o.provider,
    method: o.method,
    observationIndex: i,
    excerpt: o.error,
  });

  const timeouts = obs.map((o, i) => [o, i] as const).filter(([o]) => isTimeout(o));
  if (timeouts.length) {
    out.push({
      code: "RPC_TIMEOUT",
      title: `${plural(timeouts.length, "provider request")} timed out`,
      confidence: "high",
      explanation:
        "A timeout means NO ANSWER, not a failed transaction. NEAR providers express this differently: nearcore returns TIMEOUT_ERROR (HTTP 408, with a cause), some gateways return their own HTTP 408, and some never answer.",
      evidence: timeouts.map(([o, i]) => {
        const cause = timeoutCause(o.error);
        return ref(
          o,
          i,
          `${o.provider} did not answer ${o.method} in time (${o.latencyMs}ms)` +
            (cause ? `; nearcore cause=${cause}: ${TIMEOUT_CAUSE_MEANING[cause] ?? "undocumented cause"}` : ""),
        );
      }),
      suggestedAction: "Treat the transaction as UNKNOWN until another provider answers. Never re-sign a transaction because of a timeout.",
      retry: "unknown",
    });
  }

  const limited = obs.map((o, i) => [o, i] as const).filter(([o]) => o.error?.kind === "RATE_LIMITED");
  if (limited.length) {
    out.push({
      code: "RATE_LIMITED",
      title: `${plural(limited.length, "provider request")} ${limited.length === 1 ? "was" : "were"} rate-limited`,
      confidence: "high",
      explanation: "The provider refused the request because of a quota. This says nothing about the transaction.",
      evidence: limited.map(([o, i]) => ref(o, i, `${o.provider} returned rate-limit (HTTP ${o.httpStatus ?? "?"})`)),
      suggestedAction: "Back off, or add a provider with an API key.",
      retry: "unknown",
    });
  }

  const broken = obs
    .map((o, i) => [o, i] as const)
    .filter(([o]) => o.error && ["NETWORK", "HTTP_ERROR"].includes(o.error.kind));
  if (broken.length) {
    out.push({
      code: "NETWORK_UNAVAILABLE",
      title: `${plural(broken.length, "provider")} unreachable or returned HTTP errors`,
      confidence: "high",
      explanation: "Connection-level failures. These providers contributed no evidence.",
      evidence: broken.map(([o, i]) => ref(o, i, `${o.provider}: ${o.error!.message}`)),
      suggestedAction: "Check provider status, or remove dead endpoints from configuration.",
      retry: "unknown",
    });
  }

  const malformed = obs
    .map((o, i) => [o, i] as const)
    .filter(([o]) => o.error && ["MALFORMED", "TOO_LARGE"].includes(o.error.kind));
  if (malformed.length) {
    out.push({
      code: "MALFORMED_RESPONSE",
      title: `${plural(malformed.length, "provider response")} ${malformed.length === 1 ? "was" : "were"} malformed or oversized`,
      confidence: "high",
      explanation: "The response could not be interpreted as JSON-RPC (or exceeded the size limit), so it was discarded as evidence.",
      evidence: malformed.map(([o, i]) => ref(o, i, `${o.provider}: ${o.error!.message}`)),
      suggestedAction: "Investigate the provider; do not rely on it for this request.",
      retry: "unknown",
    });
  }
  return out;
}

/* ------------------------- submission-time errors ------------------------- */

const INVALID_TX_RULES: Array<{
  key: string;
  code: DiagnosticCode;
  title: string;
  explanation: string;
  action: string;
  retry: RetrySafety;
}> = [
  {
    key: "InvalidNonce",
    code: "INVALID_NONCE",
    title: "Nonce already used",
    explanation:
      "The access key's nonce is already >= this transaction's nonce. Either this exact transaction (or another one with the same/higher nonce) was already accepted. This is the classic symptom of a retry after a timeout.",
    action: "Do NOT blindly re-sign. First check whether the original transaction executed (check_retry_safety with the original hash).",
    retry: "unknown",
  },
  {
    key: "NonceTooLarge",
    code: "INVALID_NONCE",
    title: "Nonce too large",
    explanation: "The nonce exceeds the allowed upper bound (block height × 10^6).",
    action: "Rebuild the transaction with a fresh nonce from view_access_key.",
    retry: "safe",
  },
  {
    key: "NotEnoughBalance",
    code: "INSUFFICIENT_BALANCE",
    title: "Signer cannot cover cost",
    explanation: "The signer's balance cannot cover attached deposit + gas. The transaction was rejected and will never execute.",
    action: "Top up the signer, then sign a new transaction.",
    retry: "safe",
  },
  {
    key: "LackBalanceForState",
    code: "INSUFFICIENT_BALANCE",
    title: "Not enough balance for storage",
    explanation: "After this transaction the signer could not cover its storage staking.",
    action: "Top up the signer, then sign a new transaction.",
    retry: "safe",
  },
  {
    key: "Expired",
    code: "TRANSACTION_EXPIRED",
    title: "Transaction expired",
    explanation: "The referenced block_hash is older than the transaction validity period. An expired transaction can never be included.",
    action: "Sign a new transaction with a recent block_hash. Safe, because the expired one can never execute.",
    retry: "safe",
  },
  {
    key: "InvalidSignature",
    code: "INVALID_TRANSACTION",
    title: "Invalid signature",
    explanation: "The signature does not match the transaction and public key. It was rejected and will never execute.",
    action: "Fix the signing code/key.",
    retry: "safe",
  },
  {
    key: "InvalidAccessKeyError",
    code: "INVALID_TRANSACTION",
    title: "Access key not allowed",
    explanation: "The key does not exist, or a function-call key is calling a method/receiver it is not permitted to call, or its allowance is exhausted.",
    action: "Use a key with the right permission.",
    retry: "safe",
  },
  {
    key: "SignerDoesNotExist",
    code: "INVALID_TRANSACTION",
    title: "Signer account does not exist",
    explanation: "The signer account is not on this network.",
    action: "Check the network and account ID.",
    retry: "safe",
  },
  {
    key: "ShardCongested",
    code: "SUBMISSION_REJECTED",
    title: "Shard congested",
    explanation: "The receiving shard is congested and rejected new transactions. The transaction was NOT accepted.",
    action: "Back off and re-broadcast the same signed transaction later (it stays valid until it expires).",
    retry: "safe",
  },
  {
    key: "ShardStuck",
    code: "SUBMISSION_REJECTED",
    title: "Shard stuck",
    explanation: "The shard is not producing chunks. The transaction was NOT accepted.",
    action: "Back off and re-broadcast the same signed transaction later.",
    retry: "safe",
  },
];

/**
 * Classify an error returned when SUBMITTING a transaction (send_tx / broadcast_tx_commit),
 * or thrown by near-api-js. Accepts the raw JSON-RPC error object, a near-api-js error,
 * or any object/string containing one.
 */
export function diagnoseSubmissionError(err: unknown): Diagnostic {
  const asObj: unknown = typeof err === "string" ? safeJson(err) ?? { message: err } : err;
  const flat = JSON.stringify(asObj ?? "") + String((asObj as any)?.message ?? "");
  const evidence: EvidenceRef[] = [{ claim: "Error as received", excerpt: asObj }];

  // 1) timeouts come first: they are NOT rejections.
  if (
    findKey(asObj, ["TIMEOUT_ERROR"]) ||
    /TIMEOUT_ERROR|TimeoutError|timed out|Request timeout|ETIMEDOUT|\b408\b/i.test(flat)
  ) {
    const cause = timeoutCause(asObj);
    if (cause) evidence.push({ claim: `nearcore timeout cause=${cause}: ${TIMEOUT_CAUSE_MEANING[cause] ?? "undocumented cause"}`, excerpt: cause });
    return {
      code: "RPC_TIMEOUT",
      title: `Submission timed out — outcome unknown${cause ? ` (${cause})` : ""}`,
      confidence: "high",
      explanation:
        "The provider did not confirm within its deadline. The transaction may have been accepted and may still execute (or may already have). A timeout is NOT a rejection." +
        (cause === "PENDING"
          ? " The node reports it has SEEN the transaction: it is very likely to execute."
          : cause === "NOT_OBSERVED"
            ? " The node had not seen it yet. That does not mean other nodes have not, and it can still be included until its block_hash expires."
            : ""),
      evidence,
      suggestedAction:
        "Do NOT sign a new transaction. Re-broadcast the IDENTICAL signed transaction (duplicate-safe), or call check_retry_safety with the signed transaction to get a verdict.",
      retry: "unknown",
    };
  }

  // 2) protocol-level InvalidTxError variants.
  for (const rule of INVALID_TX_RULES) {
    const hit = findKey(asObj, [rule.key]) ?? (new RegExp(`\\b${rule.key}\\b`).test(flat) ? { key: rule.key, value: undefined } : undefined);
    if (hit) {
      if (hit.value !== undefined) evidence.push({ claim: `${rule.key} details`, excerpt: hit.value });
      return {
        code: rule.code,
        title: rule.title,
        confidence: hit.value !== undefined ? "high" : "medium",
        explanation: rule.explanation,
        evidence,
        suggestedAction: rule.action,
        retry: rule.retry,
      };
    }
  }

  if (findKey(asObj, ["ActionError", "FunctionCallError"])) {
    return {
      code: "CONTRACT_EXECUTION_FAILURE",
      title: "Transaction executed and failed",
      confidence: "medium",
      explanation: "The error describes an execution failure, meaning the transaction WAS included. Gas was spent.",
      evidence,
      suggestedAction: "Inspect the transaction by hash to see which receipt failed and whether any receipt succeeded.",
      retry: "unknown",
    };
  }

  if (/429|TOO_MANY_REQUESTS|rate.?limit/i.test(flat)) {
    return {
      code: "RATE_LIMITED",
      title: "Provider rate limit",
      confidence: "medium",
      explanation: "The provider refused the request. Whether the transaction was forwarded before the refusal is unknown.",
      evidence,
      suggestedAction: "Re-broadcast the identical signed transaction through another provider, or check status first.",
      retry: "unknown",
    };
  }

  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|network/i.test(flat)) {
    return {
      code: "NETWORK_UNAVAILABLE",
      title: "Network failure during submission",
      confidence: "medium",
      explanation: "The connection failed. If the request body was sent before the failure, the transaction may have been accepted.",
      evidence,
      suggestedAction: "Check status by hash before doing anything else.",
      retry: "unknown",
    };
  }

  return {
    code: "UNKNOWN_FAILURE",
    title: "Unrecognised error",
    confidence: "low",
    explanation: "This error does not match any known NEAR error shape. No conclusion about execution can be drawn.",
    evidence,
    suggestedAction: "Check transaction status by hash before retrying.",
    retry: "unknown",
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function notFoundDiagnostic(obs: RpcObservation[], covering: string[]): Diagnostic {
  const nf = obs.map((o, i) => [o, i] as const).filter(([o]) => isUnknownTx(o));
  return {
    code: "TX_NOT_FOUND",
    title: `Not found by ${plural(nf.length, "provider")}`,
    confidence: covering.length >= 2 ? "high" : "medium",
    explanation:
      "Providers answered UNKNOWN_TRANSACTION. On NEAR this does NOT prove the transaction never existed: non-archival nodes garbage-collect history after a few epochs, and a transaction can still be included until its block_hash expires (~86,400 blocks).",
    evidence: nf.map(([o, i]) => ({
      claim: `${o.provider} answered UNKNOWN_TRANSACTION`,
      provider: o.provider,
      method: o.method,
      observationIndex: i,
    })),
    suggestedAction: "See the retry recommendation: it combines nonce, expiry and history coverage to decide.",
    retry: "unknown",
  };
}
