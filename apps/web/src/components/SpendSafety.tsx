import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, type AllowanceSafety, type SpendPreflight } from "../api";
import { intentIdPrivacyWarning, nearOf, RECORD_FEE_NEAR } from "../vaultInfo";
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setInputError("");
    let yocto: string;
    try {
      yocto = nearToYocto(amount.trim());
    } catch {
      setInputError("Enter the amount in NEAR, for example 0.01.");
      return;
    }
    m.mutate({ contract, owner, agent, receiver: receiver.trim(), amount: yocto, intent: intent.trim() || undefined });
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
        <Field label="Payment id (optional)" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="e.g. order-7f3a" />
        <Button type="submit" icon="shieldCheck" disabled={m.isPending} className="md:mb-[1px]">
          {m.isPending ? "Checking…" : "Check payment"}
        </Button>
      </form>
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
          <p className="text-[11px] text-muted">{r.advisory}</p>
        </div>
      )}
    </section>
  );
}
