/**
 * Receiver scam check: is this payee who the agent thinks it is?
 *
 * A prompt-injected agent can be told to pay a lookalike of a real payee (`kari0s.testnet` for `karios.testnet`),
 * a poisoned raw address that shares its first and last characters with a real one, or an account that does not
 * exist. This module names the trick (the dnstwist-style technique), and reads `view_account` on every provider to
 * learn whether the receiver exists and is a contract. Read-only; never signs anything.
 *
 * Lookalike detection is a heuristic on names, not a reputation service.
 */
import { z } from "zod";
import { isUnknownAccount } from "./keys.js";
import type { RpcObservation } from "./types.js";
import { isValidAccountId } from "./validation.js";

export const MAX_KNOWN_RECEIVERS = 20;
/** Title of the finding raised when providers disagree on whether the receiver exists. */
export const PROVIDERS_DISAGREE_TITLE = "Providers disagree on whether the account exists";

export const receiverCheckInputSchema = z
  .object({
    receiverId: z.string().refine(isValidAccountId, "Invalid receiver account ID"),
    knownReceivers: z
      .array(z.string().refine(isValidAccountId, "Invalid known receiver account ID"))
      .max(MAX_KNOWN_RECEIVERS, `At most ${MAX_KNOWN_RECEIVERS} known receivers`)
      .optional(),
  })
  .strict();
export type ReceiverCheckInput = z.infer<typeof receiverCheckInputSchema>;

export type LookalikeTechnique =
  | "homoglyph"
  | "omission"
  | "insertion"
  | "replacement"
  | "transposition"
  | "vowel-swap"
  | "hyphenation"
  | "subdomain"
  | "address-poisoning";

export interface ReceiverFinding {
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail?: string;
  technique?: LookalikeTechnique;
}

export type ReceiverStatus = "OK" | "WARNING" | "DANGER" | "NOT_FOUND" | "UNKNOWN";
export type ReceiverKind = "named" | "near-implicit" | "eth-implicit" | "top-level";

export interface ReceiverProviderAnswer {
  provider: string;
  operator: string;
  answer: "EXISTS" | "NOT_FOUND" | "ERROR";
  blockHeight?: number;
  error?: string;
  latencyMs: number;
}

/** A provider answer plus the account's code hash (input of the pure decision; dropped from the result). */
export type ReceiverProviderObservation = ReceiverProviderAnswer & { codeHash?: string };

export interface ReceiverCheck {
  receiverId: string;
  status: ReceiverStatus;
  kind: ReceiverKind;
  exists?: boolean;
  isContract?: boolean;
  /** The known receiver this one imitates. */
  lookalikeOf?: string;
  /** Present when knownReceivers was given: true if the receiver is exactly one of them. */
  knownReceiver?: boolean;
  findings: ReceiverFinding[];
  reason: string;
  providers: ReceiverProviderAnswer[];
  checkedAt: string;
}

/** code_hash of an account with no contract deployed. */
export const NO_CONTRACT_CODE_HASH = "11111111111111111111111111111111";

const NEAR_IMPLICIT_RE = /^[0-9a-f]{64}$/;
const ETH_IMPLICIT_RE = /^0x[0-9a-f]{40}$/;
const NETWORK_TLDS = new Set(["near", "testnet"]);

/** PURE: what kind of account ID this is. */
export function accountKind(id: string): ReceiverKind {
  if (NEAR_IMPLICIT_RE.test(id)) return "near-implicit";
  if (ETH_IMPLICIT_RE.test(id)) return "eth-implicit";
  return id.includes(".") ? "named" : "top-level";
}

const HOMOGLYPHS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "5": "s", "4": "a", "8": "b" };
/** Lowercase, "rn"→"m", "vv"→"w", then digits that look like letters. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[013458]/g, (c) => HOMOGLYPHS[c]!);
const stripSeparators = (s: string) => s.replace(/[-_]/g, "");
/** normalize() with every separator turned into ".", so tokens compare across "-", "_" and ".". */
const unify = (s: string) => normalize(s).replace(/[-_]/g, ".");
/** The network TLD (near, testnet) of an id, or "" when it has none. */
const networkOf = (s: string) => {
  const l = s.split(".");
  return l.length > 1 && NETWORK_TLDS.has(l[l.length - 1]!) ? l[l.length - 1]! : "";
};
/** The name without its network TLD: pay.karios for pay.karios.testnet; the full id when it has no network TLD (token.sweat). */
const coreOf = (s: string) => (networkOf(s) ? s.slice(0, s.lastIndexOf(".")) : s);
const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One edit (Damerau-Levenshtein distance 1) turning `known` into `r`, classified; null otherwise. */
function oneEdit(r: string, known: string): LookalikeTechnique | null {
  if (r === known) return null;
  if (r.length === known.length) {
    const diffs: number[] = [];
    for (let i = 0; i < r.length && diffs.length <= 2; i++) if (r[i] !== known[i]) diffs.push(i);
    if (diffs.length === 1) {
      const i = diffs[0]!;
      return VOWELS.has(r[i]!) && VOWELS.has(known[i]!) ? "vowel-swap" : "replacement";
    }
    if (diffs.length === 2 && diffs[1] === diffs[0]! + 1 && r[diffs[0]!] === known[diffs[1]!] && r[diffs[1]!] === known[diffs[0]!]) return "transposition";
    return null;
  }
  const dropsTo = (long: string, short: string) => {
    if (long.length !== short.length + 1) return false;
    for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
    return false;
  };
  if (dropsTo(known, r)) return "omission";
  if (dropsTo(r, known)) return "insertion";
  return null;
}

/** Shortest core the one-edit check runs on: one edit between short names is too common to mean anything. */
const MIN_ONE_EDIT_CORE = 4;

function namedLookalike(r: string, known: string): LookalikeTechnique | null {
  // A real sub-account (shop.karios.testnet) can only be created by the known account itself.
  if (r.endsWith(`.${known}`)) return null;
  const cr = coreOf(r);
  const ck = coreOf(known);
  const nr = networkOf(r);
  const nk = networkOf(known);
  if (cr === ck) {
    // The same name on the other network (karios.near vs karios.testnet) is not a lookalike.
    if (nr && nk) return null;
    // The network suffix dropped (karios for karios.testnet) or added (karios.testnet for karios).
    return nr ? "insertion" : "omission";
  }
  // Cores are compared across networks, so kari0s.near still imitates karios.testnet.
  if (normalize(cr) === normalize(ck)) return "homoglyph";
  if (stripSeparators(cr) === stripSeparators(ck) || r.replace(/[-_.]/g, "") === known.replace(/[-_.]/g, "")) return "hyphenation";
  if (stripSeparators(normalize(cr)) === stripSeparators(normalize(ck))) return "homoglyph";
  if (ck.length >= MIN_ONE_EDIT_CORE) {
    const t = oneEdit(cr, ck);
    if (t) return t;
  }
  // A homoglyph plus one more edit (kari0ss, karl0s, k4rios1 for karios).
  const ncr = normalize(cr);
  const nck = normalize(ck);
  if (nck.length >= MIN_ONE_EDIT_CORE && oneEdit(ncr, nck)) return "homoglyph";
  // The known core as whole tokens inside a different name: karios-testnet.testnet, pay-karios.testnet,
  // karios.testnet.evil.testnet, vault-karios.testnet for vault.karios.testnet (homoglyphs too). Short cores
  // (ref, jo, bob) are common words inside unrelated names, and a top-level known name (aurora) is reused as a
  // label by unrelated accounts (aurora.pool.near), so neither gets this rule.
  if (ck.length >= MIN_ONE_EDIT_CORE && known.includes(".")) {
    if (new RegExp(`(^|[.])${escapeRe(unify(ck))}([.]|$)`).test(unify(r))) return "subdomain";
  }
  return null;
}

/**
 * PURE: which known receiver does `receiver` imitate, and how? Null when it is exactly one of them, or imitates none.
 * Named accounts are compared by name; raw (implicit) addresses only against known addresses of the same kind,
 * for address poisoning (same first 4 and last 4 characters, different address).
 */
export function lookalikeOf(receiver: string, known: readonly string[]): { of: string; technique: LookalikeTechnique } | null {
  if (known.includes(receiver)) return null;
  // A sub-account of a known account (pay2.karios.testnet when karios.testnet is known) can only be created by it.
  if (known.some((k) => receiver.endsWith(`.${k}`))) return null;
  const kind = accountKind(receiver);
  const implicit = kind === "near-implicit" || kind === "eth-implicit";
  for (const k of known) {
    if (k === receiver) continue;
    const kk = accountKind(k);
    if (implicit) {
      if (kk !== kind) continue;
      const body = (s: string) => (kind === "eth-implicit" ? s.slice(2) : s);
      const a = body(receiver);
      const b = body(k);
      if (a.slice(0, 4) === b.slice(0, 4) && a.slice(-4) === b.slice(-4)) return { of: k, technique: "address-poisoning" };
      continue;
    }
    if (kk === "near-implicit" || kk === "eth-implicit") continue;
    const technique = namedLookalike(receiver, k);
    if (technique) return { of: k, technique };
  }
  return null;
}

const TECHNIQUE_TEXT: Record<LookalikeTechnique, string> = {
  homoglyph: "characters swapped for lookalikes (0 for o, 1 for l, rn for m)",
  omission: "one character left out",
  insertion: "one character added",
  replacement: "one character replaced",
  transposition: "two neighbouring characters swapped",
  "vowel-swap": "one vowel swapped for another",
  hyphenation: "a hyphen or underscore added or removed",
  subdomain: "the real name used as part of a different account",
  "address-poisoning": "same first 4 and last 4 characters, different address",
};

/**
 * Decode one provider's `view_account` observation. A missing account is NOT_FOUND in both nearcore forms:
 * a structured UNKNOWN_ACCOUNT error, or a successful result carrying an `error` string ("... does not exist while viewing").
 */
export function receiverAnswer(base: Omit<ReceiverProviderAnswer, "answer">, obs: RpcObservation<any>): ReceiverProviderObservation {
  const blockHeight = obs.ok && typeof obs.result?.block_height === "number" ? obs.result.block_height : base.blockHeight;
  const b = { ...base, ...(blockHeight !== undefined ? { blockHeight } : {}) };
  const legacyErr = obs.ok && typeof obs.result?.error === "string" ? (obs.result.error as string) : undefined;
  if (legacyErr !== undefined)
    return /does not exist|UNKNOWN_ACCOUNT/i.test(legacyErr) ? { ...b, answer: "NOT_FOUND" } : { ...b, answer: "ERROR", error: legacyErr };
  if (!obs.ok) return isUnknownAccount(obs) ? { ...b, answer: "NOT_FOUND" } : { ...b, answer: "ERROR", error: obs.error?.message ?? "request failed" };
  const r = obs.result;
  if (!r || typeof r.amount !== "string" || !/^\d+$/.test(r.amount) || typeof r.code_hash !== "string")
    return { ...b, answer: "ERROR", error: "malformed view_account answer" };
  return { ...b, answer: "EXISTS", codeHash: r.code_hash };
}

const STATUS_RANK: Record<ReceiverStatus, number> = { OK: 0, WARNING: 1, UNKNOWN: 2, NOT_FOUND: 3, DANGER: 4 };
const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 } as const;

/**
 * PURE: combine the name checks and every provider's `view_account` answer. The worst finding sets the status.
 * Lookalikes need no network, so they are DANGER even when no provider answered.
 */
export function decideReceiver(input: ReceiverCheckInput, observations: ReceiverProviderObservation[]): Omit<ReceiverCheck, "checkedAt"> {
  const id = input.receiverId;
  const kind = accountKind(id);
  const implicit = kind === "near-implicit" || kind === "eth-implicit";
  const providers: ReceiverProviderAnswer[] = observations.map(({ codeHash: _drop, ...rest }) => rest);
  const known = input.knownReceivers;
  const knownReceiver = known ? known.includes(id) : undefined;
  const look = knownReceiver ? null : lookalikeOf(id, known ?? []);

  const findings: ReceiverFinding[] = [];
  let status: ReceiverStatus = "OK";
  const raise = (s: ReceiverStatus) => {
    if (STATUS_RANK[s] > STATUS_RANK[status]) status = s;
  };

  if (look) {
    raise("DANGER");
    findings.push(
      look.technique === "address-poisoning"
        ? {
            severity: "high",
            technique: look.technique,
            title: `Address poisoning: looks like ${look.of}`,
            detail: `${id} has the same first 4 and last 4 characters as the known address ${look.of}, but it is a different address. Scammers create such addresses so a copy from transaction history pays them. Do not pay; ask a human.`,
          }
        : {
            severity: "high",
            technique: look.technique,
            title: `Lookalike of ${look.of}`,
            detail: `${id} imitates the known receiver ${look.of} (${look.technique}: ${TECHNIQUE_TEXT[look.technique]}). Do not pay; ask a human to confirm the payee from the original source.`,
          },
    );
  }

  // Existence is worst case for named accounts: one reachable provider saying NOT_FOUND is enough (a structured
  // UNKNOWN_ACCOUNT error carries no block height, so "freshest" cannot be trusted there). Implicit accounts that do not
  // exist yet are normal, so for them the freshest answer wins (ties go to NOT_FOUND). Any disagreement is a warning.
  const answered = observations.filter((o) => o.answer !== "ERROR");
  let exists: boolean | undefined;
  let isContract: boolean | undefined;
  let note = "";
  if (!answered.length) {
    raise("UNKNOWN");
    findings.push({ severity: "medium", title: "No provider answered: existence could not be checked", detail: "Network errors on every provider. Re-check shortly." });
  } else {
    const byHeight = (xs: ReceiverProviderObservation[]) =>
      xs.reduce((a, b) => {
        const ha = a.blockHeight ?? 0;
        const hb = b.blockHeight ?? 0;
        return hb > ha || (hb === ha && b.answer === "NOT_FOUND" && a.answer !== "NOT_FOUND") ? b : a;
      });
    const notFound = answered.filter((o) => o.answer === "NOT_FOUND");
    const freshest = !implicit && notFound.length ? byHeight(notFound) : byHeight(answered);
    exists = freshest.answer === "EXISTS";
    if (new Set(answered.map((o) => o.answer)).size > 1) {
      raise("WARNING");
      findings.push({
        severity: "medium",
        title: PROVIDERS_DISAGREE_TITLE,
        detail: answered.map((o) => `${o.provider}=${o.answer}${o.blockHeight !== undefined ? `@${o.blockHeight}` : ""}`).join(", "),
      });
      note =
        !implicit && freshest.answer === "NOT_FOUND"
          ? ` Providers disagree; reporting NOT_FOUND because ${freshest.provider} says the account does not exist (worst case).`
          : ` Providers disagree; using the freshest answer (${freshest.provider}${freshest.blockHeight !== undefined ? `, block ${freshest.blockHeight}` : ""}).`;
    }
    if (exists) {
      isContract = freshest.codeHash !== undefined && freshest.codeHash !== NO_CONTRACT_CODE_HASH;
      if (isContract) findings.push({ severity: "info", title: "Contract account", detail: "A contract is deployed on this account. Merchants are often contracts; make sure this is the one you meant to pay." });
    } else if (implicit) {
      findings.push({ severity: "info", title: "Implicit account not created yet", detail: "Normal for a fresh address: the first transfer creates it. Only the holder of its key can use the funds." });
    } else {
      raise("NOT_FOUND");
      findings.push({ severity: "high", title: "Account does not exist", detail: "A payment would fail and be refunded. Likely a typo or a scam." });
    }
  }

  if (implicit && !knownReceiver) {
    raise("WARNING");
    findings.push({ severity: "medium", title: "Raw address, verify all characters", detail: "Compare every character with the original source, not just the start and end." });
  }
  if (kind === "top-level") findings.push({ severity: "info", title: "Top-level account", detail: "No network suffix such as .near or .testnet." });
  if (known && !knownReceiver)
    findings.push({ severity: "info", title: "New payee: verify it from the original source, never from transaction history" });

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const final = status as ReceiverStatus;
  const reason =
    final === "DANGER"
      ? `DANGER: ${id} looks like ${look!.of} (${look!.technique}). Do not pay; ask a human.${note}`
      : final === "NOT_FOUND"
        ? `${id} does not exist on this network, so a payment would fail. Likely a typo or a scam: do not pay; ask a human.${note}`
        : final === "UNKNOWN"
          ? `No provider answered, so it is unknown whether ${id} exists. Re-check shortly.`
          : final === "WARNING"
            ? `Check before paying ${id}: ${findings.filter((f) => f.severity === "medium").map((f) => f.title.toLowerCase()).join("; ")}.${note}`
            : exists
              ? `${id} exists${isContract ? " (a contract)" : ""}${knownReceiver ? " and is a known receiver" : ""}; no lookalike found.`
              : `${id} is a known implicit address not created yet (the first transfer creates it); no lookalike found.`;

  return {
    receiverId: id,
    status: final,
    kind,
    ...(exists !== undefined ? { exists } : {}),
    ...(isContract !== undefined ? { isContract } : {}),
    ...(look ? { lookalikeOf: look.of } : {}),
    ...(knownReceiver !== undefined ? { knownReceiver } : {}),
    findings,
    reason,
    providers,
  };
}
