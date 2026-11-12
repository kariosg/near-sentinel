/**
 * Agent key audit: can this agent's keys drain its account?
 *
 * Reads `view_access_key_list` from every provider and grades each key. A full-access key can move all NEAR,
 * add or delete keys and deploy code; a function-call key can only call one contract and cannot transfer NEAR
 * or attach a deposit. The least-privilege setup for a Sentinel Vault agent is a function-call key for the
 * vault limited to `spend`. Read-only; never signs anything and never asks for a private key.
 */
import { z } from "zod";
import { plural } from "./text.js";
import type { RpcObservation } from "./types.js";
import { isValidAccountId } from "./validation.js";

export const keyAuditInputSchema = z
  .object({
    accountId: z.string().refine(isValidAccountId, "Invalid agent account ID"),
    vaultContractId: z.string().refine(isValidAccountId, "Invalid vault contract account ID").optional(),
  })
  .strict();
export type KeyAuditInput = z.infer<typeof keyAuditInputSchema> & { /** Only used for the near-cli-rs commands (default testnet). */ network?: string };

export interface KeyFinding {
  publicKey: string;
  kind: "FULL_ACCESS" | "FUNCTION_CALL";
  receiverId?: string;
  methodNames?: string[];
  /** Gas-fee allowance in yoctoNEAR; null = unlimited (fees only, never transfers). */
  allowance: string | null;
  risk: "critical" | "review" | "good";
  why: string;
  fix?: string;
}

export type KeyAuditStatus = "FULL_ACCESS_PRESENT" | "REVIEW_NEEDED" | "LEAST_PRIVILEGE" | "NO_KEYS" | "ACCOUNT_NOT_FOUND" | "UNKNOWN";

export interface KeyProviderAnswer {
  provider: string;
  operator: string;
  answer: "KEYS" | "NOT_FOUND" | "ERROR";
  keyCount?: number;
  blockHeight?: number;
  error?: string;
  latencyMs: number;
}

export interface KeyAudit {
  accountId: string;
  vaultContractId?: string;
  status: KeyAuditStatus;
  keys: KeyFinding[];
  counts: { fullAccess: number; functionCall: number };
  reason: string;
  /** near-cli-rs commands (placeholders only, never real keys) to move to a least-privilege setup. */
  setup?: string[];
  blockHeight?: number;
  providers: KeyProviderAnswer[];
  checkedAt: string;
}

/** One raw key from `view_access_key_list`. */
export interface RawAccessKey {
  public_key: string;
  access_key: {
    nonce?: number | string;
    permission: "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

/** A provider answer plus the raw keys it returned (input of the pure decision). */
export type KeyProviderObservation = KeyProviderAnswer & { rawKeys?: RawAccessKey[] };

function isRawKey(k: any): k is RawAccessKey {
  if (!k || typeof k.public_key !== "string" || !k.access_key) return false;
  const p = k.access_key.permission;
  if (p === "FullAccess") return true;
  const f = p?.FunctionCall;
  return (
    !!f &&
    typeof f.receiver_id === "string" &&
    (f.allowance === null || f.allowance === undefined || (typeof f.allowance === "string" && /^\d+$/.test(f.allowance))) &&
    Array.isArray(f.method_names) &&
    f.method_names.every((m: unknown) => typeof m === "string")
  );
}

/**
 * Decode one provider's `view_access_key_list` observation. nearcore reports a missing account either as a
 * successful result carrying an `error` string ("account … does not exist while viewing") or as a structured
 * UNKNOWN_ACCOUNT error; both mean NOT_FOUND.
 */
export function keyListAnswer(base: Omit<KeyProviderAnswer, "answer">, obs: RpcObservation<any>, accountObs?: RpcObservation<any>): KeyProviderObservation {
  const legacyErr = obs.ok && typeof obs.result?.error === "string" ? (obs.result.error as string) : undefined;
  const blockHeight = obs.ok && typeof obs.result?.block_height === "number" ? obs.result.block_height : base.blockHeight;
  const b = { ...base, ...(blockHeight !== undefined ? { blockHeight } : {}) };
  if (legacyErr !== undefined)
    return /does not exist|UNKNOWN_ACCOUNT/i.test(legacyErr) ? { ...b, answer: "NOT_FOUND" } : { ...b, answer: "ERROR", error: legacyErr };
  if (!obs.ok) return isUnknownAccount(obs) ? { ...b, answer: "NOT_FOUND" } : { ...b, answer: "ERROR", error: obs.error?.message ?? "request failed" };
  const keys = obs.result?.keys;
  if (!Array.isArray(keys) || !keys.every(isRawKey)) return { ...b, answer: "ERROR", error: "malformed view_access_key_list answer" };
  // nearcore answers view_access_key_list for a MISSING account with `keys: []` (verified live 2026-11-12),
  // so an empty list only means NO_KEYS once view_account confirms the account exists.
  if (keys.length === 0 && accountObs) {
    if (isUnknownAccount(accountObs)) return { ...b, answer: "NOT_FOUND" };
    const accountOk = accountObs.ok && typeof accountObs.result?.error !== "string";
    if (!accountOk) return { ...b, answer: "ERROR", error: `no keys listed, and the account could not be confirmed: ${accountObs.error?.message ?? accountObs.result?.error ?? "request failed"}` };
  }
  return { ...b, answer: "KEYS", keyCount: keys.length, rawKeys: keys };
}

function isUnknownAccount(o: RpcObservation<any>): boolean {
  if (o.ok) return typeof o.result?.error === "string" && /does not exist|UNKNOWN_ACCOUNT/i.test(o.result.error);
  return o.error?.causeName === "UNKNOWN_ACCOUNT" || /UNKNOWN_ACCOUNT|account \S+ does not exist/i.test(o.error?.message ?? "");
}

const netOf = (network?: string) => (network === "mainnet" ? "mainnet" : "testnet");
export const addSpendKeyCommand = (agent: string, vault: string, network?: string) =>
  `near account add-key ${agent} grant-function-call-access --allowance '1 NEAR' --contract-account-id ${vault} --function-names 'spend' autogenerate-new-keypair save-to-keychain network-config ${netOf(network)} sign-with-keychain send`;
/** Removes a full-access key from the agent. Deleting the LAST full-access key is irreversible, so it is never the first step. */
export const deleteFullAccessKeyCommand = (agent: string, network?: string) =>
  `near account delete-keys ${agent} public-keys <ed25519:FULL_ACCESS_KEY> network-config ${netOf(network)} sign-with-keychain send`;
export const DELETE_KEY_WARNING =
  "# Only if the owner keeps ANOTHER full-access key for this account offline (or after moving its NEAR out):\n# deleting the LAST full-access key is irreversible: the account could never change keys or withdraw again.";

/** PURE: grade one key. */
export function gradeKey(k: RawAccessKey, input: KeyAuditInput): KeyFinding {
  const vault = input.vaultContractId;
  const p = k.access_key.permission;
  if (p === "FullAccess") {
    return {
      publicKey: k.public_key,
      kind: "FULL_ACCESS",
      allowance: null,
      risk: "critical",
      why: "Full access: whoever holds this key can move all NEAR, add or delete keys and deploy code on this account.",
      fix: `Give the agent a function-call key limited to 'spend' on ${vault ?? "<vault>"} and take this key off the agent's machine (keep it offline with the owner). Delete it on-chain only if another full-access key stays with the owner: deleting the last one locks the account for good.`,
    };
  }
  const f = p.FunctionCall;
  const allowance = f.allowance ?? null;
  const gasNote = allowance === null ? " It has an unlimited gas allowance (fees only)." : "";
  const base = { publicKey: k.public_key, kind: "FUNCTION_CALL" as const, receiverId: f.receiver_id, methodNames: f.method_names, allowance };
  const methods = f.method_names.length ? ` (${f.method_names.join(", ")})` : " (all methods)";
  if (f.receiver_id === input.accountId) {
    return {
      ...base,
      risk: "critical",
      why: `Calls this account's own contract${methods}. If a wallet or proxy contract is deployed there, its methods may move NEAR, so this key can be as powerful as full access.${gasNote}`,
      fix: "Delete it unless you have checked every method it can call on this account's contract.",
    };
  }
  if (!vault) {
    return {
      ...base,
      risk: "review",
      why: `Function-call key for ${f.receiver_id}${methods}: it cannot transfer NEAR itself or attach a deposit, but check what that contract's methods can do. Give the vault contract to check for least privilege.${gasNote}`,
    };
  }
  if (f.receiver_id === vault) {
    if (f.method_names.length === 1 && f.method_names[0] === "spend")
      return { ...base, risk: "good", why: `Least privilege: can only call 'spend' on ${vault}, so the vault's limits apply to every payment.${gasNote}` };
    return {
      ...base,
      risk: "review",
      why: `Can call ${f.method_names.length ? f.method_names.join(", ") : "every method"} on ${vault}, more than an agent needs.${gasNote}`,
      fix: "Limit the key to 'spend': add a new key with --function-names 'spend' and delete this one.",
    };
  }
  return {
    ...base,
    risk: "review",
    why: `Can call ${f.receiver_id}${methods}. It cannot transfer NEAR itself or attach a deposit, but check what that contract's methods can do.${gasNote}`,
    fix: `Delete it if the agent does not need ${f.receiver_id}.`,
  };
}

/** PURE: combine per-provider answers. When providers disagree the riskiest answer is graded, so safety is never overstated. */
export function decideKeyAudit(input: KeyAuditInput, observations: KeyProviderObservation[]): Omit<KeyAudit, "checkedAt"> {
  const providers: KeyProviderAnswer[] = observations.map(({ rawKeys: _drop, ...rest }) => rest);
  const base = { accountId: input.accountId, ...(input.vaultContractId ? { vaultContractId: input.vaultContractId } : {}), providers };
  const answered = observations.filter((o) => o.answer !== "ERROR");
  if (!answered.length)
    return { ...base, status: "UNKNOWN", keys: [], counts: { fullAccess: 0, functionCall: 0 }, reason: "No provider answered (network errors). The keys could not be checked; re-check shortly." };

  const sig = (o: KeyProviderObservation) =>
    o.answer === "NOT_FOUND" ? "NOT_FOUND" : JSON.stringify((o.rawKeys ?? []).map((k) => [k.public_key, k.access_key.permission]).sort());
  const split = new Set(answered.map(sig)).size > 1;
  // Never overstate safety: when providers disagree, grade the RISKIEST answer (most full-access, then critical, then
  // review keys; any key list over "not found"); ties go to the highest block. A lagging or lying provider cannot hide a key.
  const riskOf = (o: KeyProviderObservation): number[] => {
    if (o.answer === "NOT_FOUND") return [-1, 0, 0, o.blockHeight ?? 0];
    const g = (o.rawKeys ?? []).map((k) => gradeKey(k, input));
    return [g.filter((k) => k.kind === "FULL_ACCESS").length, g.filter((k) => k.risk === "critical").length, g.filter((k) => k.risk === "review").length, o.blockHeight ?? 0];
  };
  const worse = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
    return false;
  };
  const freshest = answered.reduce((a, b) => (worse(riskOf(b), riskOf(a)) ? b : a));
  const note = split ? ` Providers disagree; showing the riskiest answer (${freshest.provider}${freshest.blockHeight !== undefined ? `, block ${freshest.blockHeight}` : ""}) so nothing is overstated.` : "";
  const height = freshest.blockHeight !== undefined ? { blockHeight: freshest.blockHeight } : {};

  if (freshest.answer === "NOT_FOUND")
    return { ...base, ...height, status: "ACCOUNT_NOT_FOUND", keys: [], counts: { fullAccess: 0, functionCall: 0 }, reason: `Account ${input.accountId} does not exist on this network.${note}` };

  const keys = (freshest.rawKeys ?? []).map((k) => gradeKey(k, input));
  const counts = { fullAccess: keys.filter((k) => k.kind === "FULL_ACCESS").length, functionCall: keys.filter((k) => k.kind === "FUNCTION_CALL").length };
  const agent = input.accountId;
  const vault = input.vaultContractId ?? "<vault>";
  const needsSetup = counts.fullAccess > 0 || keys.some((k) => k.risk !== "good");
  const setup = needsSetup
    ? [addSpendKeyCommand(agent, vault, input.network), ...(counts.fullAccess > 0 ? [`${DELETE_KEY_WARNING}\n${deleteFullAccessKeyCommand(agent, input.network)}`] : [])]
    : undefined;
  const withSetup = setup ? { setup } : {};

  if (!keys.length)
    return { ...base, ...height, status: "NO_KEYS", keys, counts, reason: `${agent} has no access keys, so nobody can sign for it (it cannot spend).${note}` };
  if (counts.fullAccess > 0)
    return {
      ...base,
      ...height,
      ...withSetup,
      status: "FULL_ACCESS_PRESENT",
      keys,
      counts,
      reason: `${plural(counts.fullAccess, "full-access key")} on ${agent}: if the agent is tricked or its key leaks, everything on the account can be taken. Use a function-call key limited to 'spend' on the vault instead.${note}`,
    };
  const critical = keys.filter((k) => k.risk === "critical").length;
  const review = keys.filter((k) => k.risk === "review").length;
  if (critical || review)
    return {
      ...base,
      ...height,
      ...withSetup,
      status: "REVIEW_NEEDED",
      keys,
      counts,
      reason: `No full-access keys, but ${plural(critical + review, "function-call key")} ${critical + review === 1 ? "is" : "are"} not proven least privilege${critical ? ` (${critical} can call this account's own contract)` : ""}. Only a key limited to 'spend' on the vault is.${note}`,
    };
  return {
    ...base,
    ...height,
    ...withSetup,
    status: "LEAST_PRIVILEGE",
    keys,
    counts,
    reason: `Least privilege: ${plural(counts.functionCall, "function-call key")}, each limited to 'spend' on ${vault}, so the vault's limits apply to every payment.${note}`,
  };
}
