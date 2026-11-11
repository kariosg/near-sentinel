/**
 * SIMULATED chain for the no-wallet demo. Local only, never a real network.
 *
 * Faithful to the properties that matter for double-spend:
 *  - a tx is identified by its hash; re-sending identical bytes never executes twice
 *  - a tx executes only if its nonce > the access key nonce (then the key nonce advances)
 *  - transfers move balances
 * NOT simulated: signature verification, gas, receipts across shards. This is a demo harness.
 */
import { decodeSignedTx } from "@near-sentinel/sdk";
import { startMockRpc, type MockAnswer, type RunningServer } from "@near-sentinel/sdk/testing";
import { decodeSignedTransaction } from "near-api-js";

const BLOCK_HASH = "6PgMk66qqRgo2TsmXFnvL6kwn5FS2Z9DDqMoaYXfwXTZ";
const UNKNOWN_TX: MockAnswer = { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };

export class MockChain {
  height = 1_000_000;
  balances = new Map<string, bigint>();
  akNonce = 0n;
  txs = new Map<string, any>();
  executedTransfers = 0;

  constructor(
    readonly sender: string,
    readonly receiver: string,
    readonly publicKey: string,
  ) {
    this.balances.set(sender, 10n * 10n ** 24n);
    this.balances.set(receiver, 0n);
  }

  private execute(base64: string): MockAnswer {
    const d = decodeSignedTx(base64);
    const existing = this.txs.get(d.hash);
    if (existing) return { result: existing }; // identical bytes: deduplicated, never re-executed
    if (d.publicKey !== this.publicKey || d.signerId !== this.sender) {
      return { error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: {} } } } } };
    }
    if (d.nonce <= this.akNonce) {
      return {
        error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(d.nonce), ak_nonce: Number(this.akNonce) } } } } },
      };
    }
    const st: any = decodeSignedTransaction(Uint8Array.from(Buffer.from(base64, "base64")));
    const deposit = BigInt(st.transaction.actions[0]?.transfer?.deposit ?? 0);
    this.akNonce = d.nonce;
    this.balances.set(this.sender, (this.balances.get(this.sender) ?? 0n) - deposit);
    this.balances.set(this.receiver, (this.balances.get(this.receiver) ?? 0n) + deposit);
    this.executedTransfers++;
    this.height += 2;
    const outcome = (id: string, executor: string, status: unknown, children: string[]) => ({
      id,
      block_hash: BLOCK_HASH,
      outcome: { executor_id: executor, gas_burnt: 223_182_562_500, tokens_burnt: "22318256250000000000", logs: [], receipt_ids: children, status },
    });
    const rid = `R${this.txs.size + 1}`.padEnd(8, "x");
    const result = {
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      transaction: { hash: d.hash, signer_id: d.signerId, receiver_id: d.receiverId, public_key: d.publicKey, nonce: Number(d.nonce), actions: [{ Transfer: { deposit: deposit.toString() } }] },
      transaction_outcome: outcome(d.hash, d.signerId, { SuccessReceiptId: rid }, [rid]),
      receipts_outcome: [outcome(rid, d.receiverId, { SuccessValue: "" }, [])],
      receipts: [{ receipt_id: rid, predecessor_id: d.signerId, receiver_id: d.receiverId, receipt: { Action: { actions: [{ Transfer: { deposit: deposit.toString() } }] } } }],
    };
    this.txs.set(d.hash, result);
    return { result };
  }

  handle = (method: string, params: any): MockAnswer => {
    switch (method) {
      case "send_tx":
        return this.execute(params.signed_tx_base64);
      case "EXPERIMENTAL_tx_status": {
        const r = this.txs.get(params.tx_hash);
        return r ? { result: r } : UNKNOWN_TX;
      }
      case "query":
        if (params.request_type === "view_access_key") {
          return { result: { nonce: Number(this.akNonce), block_height: this.height, block_hash: BLOCK_HASH, permission: "FullAccess" } };
        }
        if (params.request_type === "view_account") {
          return { result: { amount: (this.balances.get(params.account_id) ?? 0n).toString(), block_height: this.height } };
        }
        return UNKNOWN_TX;
      case "block":
        if (params.finality || params.block_id === BLOCK_HASH || typeof params.block_id === "number") {
          const h = typeof params.block_id === "number" ? params.block_id : this.height;
          return { result: { header: { height: params.block_id === BLOCK_HASH ? this.height - 10 : h, hash: BLOCK_HASH, timestamp_nanosec: String(BigInt(h) * 600_000_000n) } } };
        }
        return { error: { name: "HANDLER_ERROR", code: -32000, message: "x", cause: { name: "UNKNOWN_BLOCK", info: {} } } };
      case "EXPERIMENTAL_protocol_config":
        return { result: { transaction_validity_period: 86_400 } };
      case "status":
        return { result: { chain_id: "simulated", protocol_version: 88, sync_info: { latest_block_height: this.height, earliest_block_height: 1, syncing: false } } };
      default:
        return UNKNOWN_TX;
    }
  };

  /** Two independent "providers" (different operators) over the same simulated chain state. */
  async serve(): Promise<[RunningServer, RunningServer]> {
    return [await startMockRpc(this.handle), await startMockRpc(this.handle)];
  }
}
