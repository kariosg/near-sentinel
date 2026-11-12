import { Help, Term } from "./Term";
import { GUARD_STATUS_HELP, intentIdPrivacyWarning } from "../vaultInfo";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, type IntentCheck } from "../api";
import { Icon } from "./icons";
import { Button, Card, ErrorBox, Field, Loading, Pill, toneText, type Tone } from "./ui";

const statusTone = (s: IntentCheck["status"]): Tone =>
  s === "PAID" ? "critical" : s === "PENDING" ? "warning" : s === "NOT_RECORDED" ? "good" : s === "CONFLICTING" ? "serious" : "neutral";

const yoctoToNear = (y: string) => {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-24).replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
};

/** Live Sentinel Guard deployment on testnet, with one intent paid by the live integration suite. */
const LIVE = { contract: "guard.karios.testnet", payer: "karios.testnet" };
const LIVE_EXAMPLES = [
  { label: "Paid intent", intent: "tmwbtoqi6-a", icon: "x" as const, hint: "paid once on testnet: a retry would be rejected" },
  { label: "Unused intent", intent: "never-used-intent", icon: "check" as const, hint: "nothing recorded: safe to pay" },
];

/** Look up what a deployed Sentinel Guard contract recorded for (payer, intent). Read-only. */
export function GuardPanel() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const [contract, setContract] = useState("");
  const [payer, setPayer] = useState("");
  const [intent, setIntent] = useState("");
  useEffect(() => {
    if (!contract && providers.data?.guardContractId) setContract(providers.data.guardContractId);
  }, [providers.data?.guardContractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMutation({ mutationFn: api.intent });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate({ contract: contract.trim(), payer: payer.trim(), intent: intent.trim() });
  };
  const r = m.data;

  return (
    <Card title="Guard contract — has this payment intent already been paid?" icon="shieldCheck" subtitle="Read-only lookup on the Sentinel Guard contract, cross-checked on every provider">
      <p className="mb-4 text-sm text-ink-2">
        Agents that pay through the <strong>Sentinel Guard</strong> contract (<code className="font-mono text-xs">pay(intent_id, receiver_id)</code>) can never
        double-pay: the contract rejects a repeated <Term k="intent">intent</Term> on-chain. This is a read-only lookup.
      </p>
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <Field label="Guard contract" value={contract} onChange={(e) => setContract(e.target.value)} placeholder="e.g. guard.example.testnet" required />
        <Field label="Payer account" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="e.g. agent.example.testnet" required />
        <Field label="Intent ID" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="e.g. order-42" required maxLength={64} pattern="[A-Za-z0-9._:\-]{1,64}" />
        <Button type="submit" icon="search" disabled={m.isPending} className="md:mb-[1px]">
          {m.isPending ? "Checking…" : "Check intent"}
        </Button>
      </form>
      {intentIdPrivacyWarning(intent) && (
        <p role="note" className="mt-2 text-xs text-warning">
          {intentIdPrivacyWarning(intent)}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Live testnet deployment ({LIVE.contract}):</span>
        {LIVE_EXAMPLES.map((x) => (
          <button
            key={x.intent}
            type="button"
            title={`${x.intent} (${x.hint})`}
            onClick={() => {
              setContract(LIVE.contract);
              setPayer(LIVE.payer);
              setIntent(x.intent);
              m.mutate({ contract: LIVE.contract, payer: LIVE.payer, intent: x.intent });
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink transition hover:border-link/60 hover:bg-surface-3"
          >
            <Icon name={x.icon} size={13} className="text-link" />
            {x.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-ink-2">
        You&apos;ll see: <span className="font-medium text-ink">Paid intent → PAID</span> (a retry with this intent would be refused and refunded) ·{" "}
        <span className="font-medium text-ink">Unused intent → NOT_RECORDED</span> (safe to pay).
      </p>
      {m.isPending && <Loading label="Asking every provider…" />}
      {m.isError && (
        <div className="mt-3">
          <ErrorBox error={m.error} />
        </div>
      )}
      {r && (
        <div className="mt-5 space-y-4 animate-fade-up" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
            <span className={`grid h-9 w-9 place-items-center rounded-lg bg-surface-3 ${toneText[statusTone(r.status)]}`}>
              <Icon name={r.status === "NOT_RECORDED" ? "check" : r.status === "PAID" ? "x" : r.status === "PENDING" ? "clock" : "info"} size={17} />
            </span>
            <Pill tone={statusTone(r.status)}>{r.status}</Pill>
            <span className="text-sm text-ink">{r.reason}</span>
            {GUARD_STATUS_HELP[r.status] && <span className="basis-full text-xs text-ink-2">{GUARD_STATUS_HELP[r.status]}</span>}
          </div>
          {r.intent && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">
                Receiver<Help label="receiver">The account the Guard paid for this intent.</Help>
              </dt>
              <dd className="font-mono text-ink-2">{r.intent.receiver_id}</dd>
              <dt className="text-muted">
                Amount<Help label="amount">The NEAR forwarded to the receiver: the payer's deposit minus a small storage fee the Guard keeps for the pay-once record.</Help>
              </dt>
              <dd className="text-ink-2">{yoctoToNear(r.intent.amount)} NEAR</dd>
              <dt className="text-muted">
                Recorded at block<Help label="recorded at block">The NEAR block where the Guard stored this payment. Every provider must see the same record.</Help>
              </dt>
              <dd className="text-ink-2">{r.intent.block_height}</dd>
            </dl>
          )}
          <table className="w-full text-sm">
            <caption className="sr-only">Per-provider answers</caption>
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-normal">Provider</th>
                <th className="py-1 font-normal">Answer</th>
                <th className="py-1 text-right font-normal">Latency</th>
              </tr>
            </thead>
            <tbody>
              {r.providers.map((p) => (
                <tr key={p.provider} className="border-t border-line">
                  <td className="py-1.5 text-ink">{p.provider}</td>
                  <td className="py-1.5">
                    <Pill tone={p.answer === "ERROR" ? "warning" : p.answer === "RECORDED" ? "info" : "neutral"}>{p.answer}</Pill>
                    {p.error && <span className="ml-2 text-xs text-muted">{p.error}</span>}
                  </td>
                  <td className="py-1.5 text-right text-ink-2">{p.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
