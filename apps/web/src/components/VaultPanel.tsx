import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, type AllowanceCheck } from "../api";
import { Icon } from "./icons";
import { Button, Card, ErrorBox, Field, Loading, Pill, toneText, type Tone } from "./ui";
import { VaultOwnerActions } from "./VaultOwnerActions";

const statusTone = (s: AllowanceCheck["status"]): Tone =>
  s === "ACTIVE" ? "good" : s === "EXHAUSTED" ? "warning" : s === "FROZEN" ? "critical" : s === "NO_POLICY" ? "neutral" : "serious";

const nearOf = (y: string) => {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-24).replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : whole;
};

/** Live Sentinel Vault on testnet: an allowance funded by the owner for an agent account. */
const LIVE = { contract: "vault.karios.testnet", owner: "karios.testnet", agent: "kariosr.testnet" };

/** How much may an agent spend right now from a Sentinel Vault allowance? Read-only. */
export function VaultPanel() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const [contract, setContract] = useState("");
  const [owner, setOwner] = useState("");
  const [agent, setAgent] = useState("");
  useEffect(() => {
    if (!contract && providers.data?.vaultContractId) setContract(providers.data.vaultContractId);
  }, [providers.data?.vaultContractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMutation({ mutationFn: api.allowance });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate({ contract: contract.trim(), owner: owner.trim(), agent: agent.trim() });
  };
  const r = m.data;
  const p = r?.policy;

  return (
    <Card title="Agent allowance — how much may this agent spend now?" icon="wallet" subtitle="Read-only lookup on the Sentinel Vault contract, cross-checked on every provider">
      <p className="mb-4 text-sm text-ink-2">
        <strong>Sentinel Vault</strong> gives an AI agent money without giving it the keys: the owner funds an allowance with a per-payment limit, a 24-hour
        limit and an optional receiver allowlist, and the agent spends with a function-call key that can only call{" "}
        <code className="font-mono text-xs">spend(owner_id, intent_id, receiver_id, amount)</code>. Each intent pays at most once.
      </p>
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <Field label="Vault contract" value={contract} onChange={(e) => setContract(e.target.value)} placeholder="e.g. vault.example.testnet" required />
        <Field label="Owner account" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. alice.testnet" required />
        <Field label="Agent account" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. agent.alice.testnet" required />
        <Button type="submit" icon="search" disabled={m.isPending} className="md:mb-[1px]">
          {m.isPending ? "Checking…" : "Check allowance"}
        </Button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Live testnet vault ({LIVE.contract}):</span>
        <button
          type="button"
          title={`${LIVE.owner} → ${LIVE.agent}`}
          onClick={() => {
            setContract(LIVE.contract);
            setOwner(LIVE.owner);
            setAgent(LIVE.agent);
            m.mutate(LIVE);
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink transition hover:border-link/60 hover:bg-surface-3"
        >
          <Icon name="wallet" size={13} className="text-link" />
          Live agent allowance
        </button>
      </div>
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
              <Icon name={r.status === "ACTIVE" ? "check" : r.status === "FROZEN" ? "lock" : "info"} size={17} />
            </span>
            <Pill tone={statusTone(r.status)}>{r.status}</Pill>
            <span className="text-sm text-ink">{r.reason}</span>
          </div>
          {p && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Available now</dt>
              <dd className="font-semibold text-ink">{nearOf(r.availableNow)} NEAR</dd>
              <dt className="text-muted">Per payment / per 24 h</dt>
              <dd className="text-ink-2">
                {nearOf(p.per_payment_max)} / {nearOf(p.daily_max)} NEAR (spent in window: {nearOf(p.spent_in_window)})
              </dd>
              <dt className="text-muted">Balance</dt>
              <dd className="text-ink-2">{nearOf(p.balance)} NEAR</dd>
              <dt className="text-muted">Allowed receivers</dt>
              <dd className="font-mono text-ink-2">{p.allowed_receivers.length ? p.allowed_receivers.join(", ") : "any"}</dd>
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
              {r.providers.map((x) => (
                <tr key={x.provider} className="border-t border-line">
                  <td className="py-1.5 text-ink">{x.provider}</td>
                  <td className="py-1.5">
                    <Pill tone={x.answer === "ERROR" ? "warning" : x.answer === "POLICY" ? "info" : "neutral"}>{x.answer}</Pill>
                    {x.error && <span className="ml-2 text-xs text-muted">{x.error}</span>}
                  </td>
                  <td className="py-1.5 text-right text-ink-2">{x.latencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <VaultOwnerActions contract={contract} />
    </Card>
  );
}
