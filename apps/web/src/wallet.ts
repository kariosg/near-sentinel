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
  const hash = (out as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined)?.transaction?.hash ?? (out as any)?.transaction_outcome?.id;
  if (!hash) throw new Error("The wallet did not return a transaction hash.");
  return hash;
}

/** "1.5" NEAR → yoctoNEAR string, exact (no floating point). Rejects more than 24 decimals or bad input. */
export function nearToYocto(near: string): string {
  const s = near.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(`"${near}" is not a NEAR amount (use digits, up to 24 decimals).`);
  const [whole, frac = ""] = s.split(".");
  const y = (BigInt(whole!) * 10n ** 24n + BigInt(frac.padEnd(24, "0"))).toString();
  return y;
}
