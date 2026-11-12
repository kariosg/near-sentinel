/**
 * NEAR Connect (@hot-labs/near-connect), NEAR's recommended wallet connector (Wallet Selector is deprecated).
 * Loaded lazily on the first "Connect wallet" click, so page loads never fetch wallet code.
 * The user's own wallet signs; this dashboard and the Sentinel server never hold a key.
 */
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";

let connectorP: Promise<NearConnector> | undefined;

function connector(): Promise<NearConnector> {
  connectorP ??= import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network: "testnet" }));
  return connectorP;
}

export interface Connected {
  accountId: string;
  wallet: NearWalletBase;
}

/** Open the wallet picker and return the connected account. */
export async function connectWallet(): Promise<Connected> {
  const c = await connector();
  const wallet = await c.connect();
  const accounts = await wallet.getAccounts();
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("The wallet returned no account.");
  return { accountId, wallet };
}

export async function disconnectWallet(wallet?: NearWalletBase): Promise<void> {
  if (!connectorP) return;
  const c = await connectorP;
  await c.disconnect(wallet);
}

/** One FunctionCall transaction, signed and sent by the user's wallet. Returns the transaction hash. */
export async function signAndSendFunctionCall(
  wallet: NearWalletBase,
  signerId: string,
  receiverId: string,
  methodName: string,
  args: object,
  depositYocto: string,
  gas = "60000000000000",
): Promise<string> {
  const out = await wallet.signAndSendTransaction({
    network: "testnet",
    signerId,
    receiverId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit: depositYocto } }],
  });
  const o = out as
    | { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: { Failure?: unknown }; receipts_outcome?: Array<{ outcome?: { status?: { Failure?: unknown } } }> }
    | undefined;
  const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  // A wallet can return the final outcome of a transaction that failed on-chain: report it as a failure, never as "sent".
  const failure = o?.status?.Failure ?? o?.receipts_outcome?.find((r) => r.outcome?.status?.Failure)?.outcome?.status?.Failure;
  if (failure) throw new Error(`${JSON.stringify(failure)}${hash ? ` (tx ${hash})` : ""}`);
  if (!hash) throw new Error("The wallet did not return a transaction hash.");
  return hash;
}

export interface AccountBalance {
  /** Everything the account holds, in yoctoNEAR (`amount` from view_account; staked NEAR is separate). */
  total: string;
  /** Kept by NEAR to pay for the account's storage; cannot be spent. */
  storageReserved: string;
  /** Staked / locked by the protocol. */
  locked: string;
  /** What the wallet can spend now: total minus storage reserve. */
  available: string;
}

/** Public, read-only testnet RPC used only to show the connected wallet's balance. */
const BALANCE_RPC = "https://test.rpc.fastnear.com";

/** Read-only `view_account` for the connected account. Never signs anything. */
export async function accountBalance(accountId: string): Promise<AccountBalance> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(BALANCE_RPC, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "balance", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
    });
    const j = (await res.json()) as { result?: { amount?: string; locked?: string; storage_usage?: number }; error?: { message?: string } };
    const r = j.result;
    if (!r || typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) throw new Error(j.error?.message ?? "No balance returned");
    const total = BigInt(r.amount);
    const storage = BigInt(r.storage_usage ?? 0) * 10n ** 19n;
    const available = total > storage ? total - storage : 0n;
    return { total: total.toString(), storageReserved: storage.toString(), locked: /^\d+$/.test(r.locked ?? "") ? r.locked! : "0", available: available.toString() };
  } finally {
    clearTimeout(t);
  }
}

/** "1.5" NEAR → yoctoNEAR string, exact (no floating point). Rejects more than 24 decimals or bad input. */
export function nearToYocto(near: string): string {
  const s = near.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(`"${near}" is not a NEAR amount (use digits, up to 24 decimals).`);
  const [whole, frac = ""] = s.split(".");
  const y = (BigInt(whole!) * 10n ** 24n + BigInt(frac.padEnd(24, "0"))).toString();
  return y;
}
