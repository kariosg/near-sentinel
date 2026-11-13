import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type AllowanceSafety, type ReceiverCheck, type SpendPreflight } from "../api";
import { diffParts, intentIdPrivacyWarning, nearOf, RECORD_FEE_NEAR } from "../vaultInfo";
import { nearToYocto } from "../wallet";
import { Icon } from "./icons";
import { Help } from "./Term";
import { Button, ErrorBox, Field, Loading, Pill, type Tone } from "./ui";

const gradeTone = (g: AllowanceSafety["grade"]): Tone => (g === "strong" ? "good" : g === "fair" ? "warning" : "critical");
const sevTone = (s: AllowanceSafety["findings"][number]["severity"]): Tone =>
  s === "high" ? "critical" : s === "medium" ? "warning" : s === "low" ? "neutral" : "info";

/** Allowance safety check: how risky are these limits if the agent is compromised or tricked? */
export function SafetyBlock({ safety }: { safety: AllowanceSafety }) {
  return (
    <section aria-label="Safety check" className="rounded-xl border border-line bg-surface-2/40 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="shieldCheck" size={16} className="text-link" />
        <span className="font-medium text-ink">Safety check</span>
        <Pill tone={gradeTone(safety.grade)}>
          {safety.grade} · {safety.score}/100
        </Pill>
        <Help label="safety check">
          How much damage these limits allow if the agent is hacked or tricked by a prompt injection. The limits are enforced by the contract, not by the AI, so a tricked agent can
          never go past them.
        </Help>
      </div>
      {safety.findings.length === 0 ? (
        <p className="mt-2 text-xs text-ink-2">No risky settings found: limited receivers, a per-payment limit below the daily limit, and a daily limit below the balance.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {safety.findings.map((f) => (
            <li key={f.title} className="flex flex-wrap items-baseline gap-2 text-xs">
              <Pill tone={sevTone(f.severity)}>{f.severity}</Pill>
              <span className="text-ink">{f.title}</span>
              {f.fix && <span className="basis-full pl-1 text-ink-2">Fix: {f.fix}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Would this payment be allowed?" — the Vault's own checks, run read-only before anything is signed. */
export function PreflightForm({ contract, owner, agent }: { contract: string; owner: string; agent: string }) {
  const [receiver, setReceiver] = useState("");
  const [amount, setAmount] = useState("");
  const [intent, setIntent] = useState("");
  const [inputError, setInputError] = useState("");
  const m = useMutation({ mutationFn: api.spendPreflight });
  const privacy = intentIdPrivacyWarning(intent);

  const run = (recv: string, amt: string) => {
    setInputError("");
    let yocto: string;
    try {
      yocto = nearToYocto(amt.trim());
    } catch {
      setInputError("Enter the amount in NEAR, for example 0.01.");
      return;
    }
    m.mutate({ contract, owner, agent, receiver: recv.trim(), amount: yocto, intent: intent.trim() || undefined });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(receiver, amount);
  };
  /** One-click demo: a normal payment to the owner's only allowed receiver. */
  const tryAllowed = () => {
    const recv = "karios.testnet";
    const amt = "0.01";
    setReceiver(recv);
    setAmount(amt);
    run(recv, amt);
  };
  /** One-click demo: a prompt-injected agent is told to pay a lookalike of the real payee. */
  const tryLookalike = () => {
    const recv = "kari0s.testnet";
    const amt = amount.trim() || "0.01";
    setReceiver(recv);
    setAmount(amt);
    run(recv, amt);
  };
  const r: SpendPreflight | undefined = m.data;
  const tone: Tone = r?.decision === "ALLOWED" ? "good" : r?.decision === "BLOCKED" ? "critical" : "serious";

  return (
    <section aria-labelledby="preflight-title" className="rounded-xl border border-line px-4 py-4">
      <h3 id="preflight-title" className="flex items-center gap-1 text-sm font-semibold text-ink">
        Would this payment be allowed?
        <Help label="payment check">
          Runs the Vault&apos;s own rules (frozen, allowed receivers, per-payment and 24-hour limits, balance plus the {RECORD_FEE_NEAR} NEAR fee, and an already-used payment id) before
          anything is signed. An agent can call this first and stop early. The contract still enforces the same rules on-chain.
        </Help>
      </h3>
      <p className="mt-1 text-xs text-ink-2">
        For {agent} paying from {owner}&apos;s allowance. Read-only: nothing is signed or sent.
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-[1.2fr_0.8fr_1fr_auto] md:items-end">
        <Field label="Receiver" value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="e.g. shop.testnet" required />
        <Field label="Amount (NEAR)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.01" inputMode="decimal" required />
        <Field label="Intent ID (optional)" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="e.g. order-7f3a" />
        <Button type="submit" icon="shieldCheck" disabled={m.isPending} className="md:mb-[1px]">
          {m.isPending ? "Checking…" : "Check payment"}
        </Button>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={tryAllowed}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink transition hover:border-link/60 hover:bg-surface-3"
        >
          <Icon name="check" size={13} className="text-good" />
          Try an allowed payment
        </button>
        <button
          type="button"
          onClick={tryLookalike}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink transition hover:border-link/60 hover:bg-surface-3"
        >
          <Icon name="alert" size={13} className="text-warning" />
          Try a scam lookalike
        </button>
        <span className="text-[11px] text-ink-2">
          You&apos;ll see: 0.01 NEAR to <span className="font-medium text-ink">karios.testnet</span> ALLOWED; <span className="font-medium text-ink">kari0s.testnet</span> (zero, not o) BLOCKED and flagged as a lookalike.
        </span>
      </div>
      {privacy && (
        <p role="note" className="mt-2 text-xs text-warning">
          {privacy}
        </p>
      )}
      {inputError && (
        <p role="alert" className="mt-2 text-xs text-critical">
          {inputError}
        </p>
      )}
      {m.isPending && <Loading label="Checking the Vault on every provider…" />}
      {m.isError && (
        <div className="mt-3">
          <ErrorBox error={m.error} />
        </div>
      )}
      {r && (
        <div className="mt-3 space-y-1.5 animate-fade-up" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={tone}>{r.decision}</Pill>
            {r.code && <code className="font-mono text-xs text-muted">{r.code}</code>}
            <span className="text-sm text-ink">{r.reason}</span>
          </div>
          {r.decision === "ALLOWED" && (
            <p className="text-xs text-ink-2">
              Cost from the vault: {nearOf(r.costYocto)} NEAR ({nearOf(r.amount)} + {RECORD_FEE_NEAR} fee).
            </p>
          )}
          {r.receiverCheck && <ReceiverBlock rc={r.receiverCheck} />}
          <p className="text-[11px] text-muted">{r.advisory}</p>
        </div>
      )}
    </section>
  );
}

const rcTone = (s: ReceiverCheck["status"]): Tone =>
  s === "OK" ? "good" : s === "DANGER" ? "critical" : s === "NOT_FOUND" ? "serious" : s === "WARNING" ? "warning" : "neutral";
const KIND: Record<ReceiverCheck["kind"], string> = {
  named: "named account",
  "near-implicit": "raw NEAR address (64 hex)",
  "eth-implicit": "raw Ethereum-style address",
  "top-level": "top-level account",
};

/**
 * Side-by-side comparison (as wallets show for address poisoning). Only the part that differs is marked: the common
 * prefix and suffix are removed first, so an inserted or missing character does not mark the rest of the name.
 */
function Compare({ a, b }: { a: string; b: string }) {
  const row = (x: string, y: string, label: string) => {
    const d = diffParts(x, y);
    return (
      <div className="flex items-baseline gap-2">
        <span className="w-20 shrink-0 text-[11px] text-muted">{label}</span>
        <code className="break-all font-mono text-xs text-ink-2">
          {d.pre}
          {d.mid ? (
            <mark className="rounded-sm bg-critical/25 px-px font-bold text-critical">{d.mid}</mark>
          ) : (
            <mark className="mx-px rounded-sm border border-critical/60 bg-transparent px-0.5 text-[10px] text-critical" title="missing here">
              ∅
            </mark>
          )}
          {d.post}
        </code>
      </div>
    );
  };
  const da = diffParts(a, b);
  const db = diffParts(b, a);
  const summary = `${a} differs from the known payee ${b}: "${da.mid || "nothing"}" instead of "${db.mid || "nothing"}" after "${da.pre}".`;
  return (
    <div role="group" aria-label={`Compare ${a} with ${b}`} className="mt-1.5 space-y-0.5 rounded-lg border border-line bg-surface-2/50 px-3 py-2">
      <span className="sr-only">{summary}</span>
      <div aria-hidden="true">
        {row(a, b, "Paying")}
        {row(b, a, "Known payee")}
      </div>
    </div>
  );
}

/** Receiver scam check: lookalike names, address poisoning, missing accounts, raw addresses. */
export function ReceiverBlock({ rc }: { rc: ReceiverCheck }) {
  return (
    <section aria-label="Receiver check" className="mt-2 rounded-xl border border-line bg-surface-2/40 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="search" size={14} className="text-link" />
        <span className="font-medium text-ink">Receiver check</span>
        <Pill tone={rcTone(rc.status)}>{rc.status}</Pill>
        <span className="text-ink-2">
          {rc.receiverId} · {KIND[rc.kind]}
          {rc.exists === false ? " · does not exist" : rc.isContract ? " · contract" : ""}
        </span>
        <Help label="receiver check">
          Before paying, Sentinel checks the receiver on every provider: does it exist, is it a raw address, and does it imitate a known payee (a swapped letter, 0 for o, an extra
          word, or a raw address that matches a known one only at the start and end, called address poisoning). DANGER or NOT_FOUND: do not pay; ask a human.
        </Help>
      </div>
      <p className="mt-1 text-ink-2">{rc.reason}</p>
      {rc.lookalikeOf && <Compare a={rc.receiverId} b={rc.lookalikeOf} />}
      {rc.findings.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {rc.findings.map((f, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2">
              <Pill tone={f.severity === "high" ? "critical" : f.severity === "medium" ? "warning" : f.severity === "low" ? "neutral" : "info"}>{f.severity}</Pill>
              <span className="text-ink">{f.title}</span>
              {f.technique && <code className="font-mono text-[11px] text-muted">{f.technique}</code>}
              {f.detail && <span className="basis-full pl-1 text-ink-2">{f.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
