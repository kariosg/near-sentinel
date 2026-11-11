/**
 * Pure functions that turn a nearcore `EXPERIMENTAL_tx_status` result into
 * a receipt execution graph and an application-level TxState.
 * No I/O here — fully deterministic and fixture-tested.
 */
import type {
  ExecutionFailure,
  ReceiptAction,
  ReceiptNode,
  ReceiptStatus,
  TransactionSummary,
  TxExecutionStatus,
  TxState,
} from "./types.js";

/** Minimal structural view of the nearcore RPC result we rely on. */
export interface RawTxStatusResult {
  final_execution_status?: TxExecutionStatus;
  status: unknown;
  transaction: {
    hash: string;
    signer_id: string;
    receiver_id: string;
    public_key: string;
    nonce: number | string;
    actions: unknown[];
  };
  transaction_outcome: RawOutcomeWithId;
  receipts_outcome: RawOutcomeWithId[];
  /** Present only for EXPERIMENTAL_tx_status. */
  receipts?: Array<{ receipt_id: string; predecessor_id: string; receiver_id: string; receipt: any }>;
}

export interface RawOutcomeWithId {
  id: string;
  block_hash: string;
  outcome: {
    executor_id: string;
    gas_burnt: number;
    tokens_burnt: string;
    logs: string[];
    receipt_ids: string[];
    status: unknown;
  };
}

const FINALITY_ORDER: TxExecutionStatus[] = [
  "NONE",
  "INCLUDED",
  "EXECUTED_OPTIMISTIC",
  "INCLUDED_FINAL",
  "EXECUTED",
  "FINAL",
];
export function finalityRank(s: TxExecutionStatus | undefined): number {
  return s ? FINALITY_ORDER.indexOf(s) : -1;
}

export function receiptStatusOf(raw: unknown): ReceiptStatus {
  if (raw && typeof raw === "object") {
    if ("Failure" in raw) return "FAILURE";
    if ("SuccessValue" in raw || "SuccessReceiptId" in raw) return "SUCCESS";
  }
  // "Unknown" (string) or anything else: not executed yet.
  return "PENDING";
}

/** Flatten the nested nearcore error enum into a path + the deepest human message. */
export function flattenFailure(raw: unknown): ExecutionFailure {
  const path: string[] = [];
  let node: any = raw;
  let message = "";
  for (let i = 0; i < 12 && node !== undefined && node !== null; i++) {
    if (typeof node === "string") {
      message = node;
      break;
    }
    if (typeof node !== "object") {
      message = String(node);
      break;
    }
    // ActionError has {index, kind}; descend into kind.
    if ("kind" in node && "index" in node) {
      node = node.kind;
      continue;
    }
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      message = JSON.stringify(node);
      break;
    }
    const k = keys[0]!;
    path.push(k);
    node = node[k];
  }
  if (!message) message = path[path.length - 1] ?? "Unknown failure";
  return { path, message, raw };
}

function summarizeAction(a: unknown): ReceiptAction {
  if (typeof a === "string") return { type: a };
  if (!a || typeof a !== "object") return { type: "Unknown" };
  const type = Object.keys(a)[0] ?? "Unknown";
  const body: any = (a as any)[type] ?? {};
  switch (type) {
    case "FunctionCall": {
      const argBytes = typeof body.args === "string" ? Math.floor((body.args.length * 3) / 4) : 0;
      return {
        type,
        methodName: body.method_name,
        deposit: String(body.deposit ?? "0"),
        gas: body.gas,
        summary: `${body.method_name}(${argBytes} bytes args)`,
      };
    }
    case "Transfer":
      return { type, deposit: String(body.deposit ?? "0"), summary: `transfer ${body.deposit} yocto` };
    case "AddKey":
      return { type, summary: `add key ${String(body.public_key ?? "").slice(0, 20)}…` };
    case "DeleteKey":
      return { type, summary: `delete key ${String(body.public_key ?? "").slice(0, 20)}…` };
    case "Stake":
      return { type, deposit: String(body.stake ?? "0"), summary: `stake ${body.stake}` };
    case "DeleteAccount":
      return { type, summary: `delete account → ${body.beneficiary_id}` };
    default:
      return { type };
  }
}

export function summarizeTransaction(r: RawTxStatusResult): TransactionSummary {
  return {
    hash: r.transaction.hash,
    signerId: r.transaction.signer_id,
    receiverId: r.transaction.receiver_id,
    publicKey: r.transaction.public_key,
    nonce: String(r.transaction.nonce),
    actions: (r.transaction.actions ?? []).map(summarizeAction),
  };
}

/**
 * Build the receipt DAG rooted at the transaction's first receipt.
 * Handles: missing receipt bodies (plain `tx` method), outcomes referencing receipts
 * not yet present (pending), and cycles (defensive; should not happen).
 */
export function buildReceiptTree(r: RawTxStatusResult): { root?: ReceiptNode; nodes: ReceiptNode[] } {
  const outcomes = new Map(r.receipts_outcome.map((o) => [o.id, o]));
  const bodies = new Map((r.receipts ?? []).map((x) => [x.receipt_id, x]));
  const nodes: ReceiptNode[] = [];
  const visiting = new Set<string>();

  const make = (id: string, depth: number): ReceiptNode => {
    const o = outcomes.get(id);
    const body = bodies.get(id);
    const pred = body?.predecessor_id;
    const actionsRaw: unknown[] = body?.receipt?.Action?.actions ?? [];
    const node: ReceiptNode = {
      receiptId: id,
      executorId: o?.outcome.executor_id ?? body?.receiver_id ?? "(unknown)",
      predecessorId: pred,
      isRefund: pred === "system",
      status: o ? receiptStatusOf(o.outcome.status) : "PENDING",
      rawStatus: o?.outcome.status ?? "Unknown",
      actions: body?.receipt?.Data ? [{ type: "Data" }] : actionsRaw.map(summarizeAction),
      gasBurnt: o?.outcome.gas_burnt ?? 0,
      tokensBurnt: o?.outcome.tokens_burnt ?? "0",
      logs: o?.outcome.logs ?? [],
      blockHash: o?.block_hash ?? "",
      children: [],
      depth,
    };
    if (node.status === "FAILURE") node.failure = flattenFailure((o!.outcome.status as any).Failure);
    nodes.push(node);
    if (visiting.has(id)) return node;
    visiting.add(id);
    for (const child of o?.outcome.receipt_ids ?? []) node.children.push(make(child, depth + 1));
    visiting.delete(id);
    return node;
  };

  const rootId = r.transaction_outcome.outcome.receipt_ids[0];
  const root = rootId ? make(rootId, 0) : undefined;
  return { root, nodes };
}

export interface Classification {
  state: TxState;
  /** Non-refund receipts that failed. */
  failed: ReceiptNode[];
  /** Non-refund receipts that succeeded. */
  succeeded: ReceiptNode[];
  pending: ReceiptNode[];
  /** Top-level status is success but a downstream receipt failed (a callback swallowed it). */
  downstreamFailureMasked: boolean;
}

/**
 * Map a found transaction to an application state.
 *
 *  - any receipt not yet executed (or final_execution_status INCLUDED*) → INCLUDED
 *  - all non-refund receipts SUCCESS → EXECUTED_SUCCESS
 *  - all non-refund receipts FAILURE → EXECUTED_FAILURE
 *  - mixed → PARTIALLY_COMPLETED (the workflow did not complete as a unit)
 */
export function classifyFound(r: RawTxStatusResult, nodes: ReceiptNode[]): Classification {
  const real = nodes.filter((n) => !n.isRefund);
  const failed = real.filter((n) => n.status === "FAILURE");
  const succeeded = real.filter((n) => n.status === "SUCCESS");
  const pending = nodes.filter((n) => n.status === "PENDING");
  const topStatus = receiptStatusOf(r.status);
  const fes = r.final_execution_status;
  const stillIncluding = fes === "INCLUDED" || fes === "INCLUDED_FINAL" || fes === "NONE";

  let state: TxState;
  if (pending.length > 0 || stillIncluding || topStatus === "PENDING") state = "INCLUDED";
  else if (failed.length === 0) state = "EXECUTED_SUCCESS";
  else if (succeeded.length === 0) state = "EXECUTED_FAILURE";
  else state = "PARTIALLY_COMPLETED";

  return {
    state,
    failed,
    succeeded,
    pending,
    downstreamFailureMasked: topStatus === "SUCCESS" && failed.length > 0,
  };
}

/** Stable digest for cross-provider comparison. Ignores gas profiles/metadata that legitimately differ. */
export function outcomeDigest(r: RawTxStatusResult): string {
  const parts = [
    JSON.stringify(r.status),
    ...r.receipts_outcome
      .map((o) => `${o.id}:${receiptStatusOf(o.outcome.status)}:${o.outcome.tokens_burnt}:${o.outcome.receipt_ids.join(",")}`)
      .sort(),
  ];
  // FNV-1a 32-bit; collision resistance is irrelevant here, determinism is.
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function totals(nodes: ReceiptNode[], r: RawTxStatusResult): { gas: number; tokens: string } {
  let gas = r.transaction_outcome.outcome.gas_burnt;
  let tokens = BigInt(r.transaction_outcome.outcome.tokens_burnt);
  for (const n of nodes) {
    gas += n.gasBurnt;
    tokens += BigInt(n.tokensBurnt);
  }
  return { gas, tokens: tokens.toString() };
}
