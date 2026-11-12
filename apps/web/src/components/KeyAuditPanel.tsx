import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, type KeyAudit, type KeyFinding } from "../api";
import { explorerAccount } from "../demoData";
import { KEY_STATUS_HELP, nearOf } from "../vaultInfo";
import { Icon } from "./icons";
import { Help, Term } from "./Term";
import { Button, Card, CodeBlock, ErrorBox, Field, Loading, Pill, toneText, type Tone } from "./ui";

const statusTone = (s: KeyAudit["status"]): Tone =>
  s === "LEAST_PRIVILEGE" ? "good" : s === "FULL_ACCESS_PRESENT" ? "critical" : s === "REVIEW_NEEDED" ? "warning" : s === "NO_KEYS" || s === "ACCOUNT_NOT_FOUND" ? "neutral" : "serious";
const riskTone = (r: KeyFinding["risk"]): Tone => (r === "good" ? "good" : r === "critical" ? "critical" : "warning");
const riskLabel = (r: KeyFinding["risk"]) => (r === "good" ? "Least privilege" : r === "critical" ? "Full access" : "Review");

/** The live demo agent: it really uses a full-access key, so the check shows what to fix. */
const LIVE = { account: "kariosr.testnet", vault: "vault.karios.testnet" };

/** Agent key check: can this agent's keys drain its account? Read-only, on every provider. */
export function KeyAuditPanel() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const [account, setAccount] = useState("");
  const [vault, setVault] = useState("");
  useEffect(() => {
    if (!vault && providers.data?.vaultContractId) setVault(providers.data.vaultContractId);
  }, [providers.data?.vaultContractId]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMutation({ mutationFn: api.agentKeys });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate({ account: account.trim(), vault: vault.trim() || undefined });
  };
  const r = m.data;

  return (
    <Card title="Agent keys — can this agent drain its account?" icon="lock" subtitle="Read-only check of every access key on the account, cross-checked on every provider">
      <p className="mb-4 text-sm text-ink-2">
        An AI agent should never hold a <strong>full-access key</strong>: if it leaks (or the agent is tricked by a prompt injection), the whole account can be emptied. The safe
        setup is a <Term k="fckey">function-call key</Term> that can only call the Vault&apos;s <code className="font-mono text-xs">spend</code>, so the most it can ever pay is
        the owner&apos;s <Term k="allowance">allowance</Term>.
      </p>
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field label="Agent account" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. agent.alice.testnet" required />
        <Field
          label="Vault contract (optional)"
          hint="Needed to confirm least privilege: the key must be limited to spend on this vault."
          value={vault}
          onChange={(e) => setVault(e.target.value)}
          placeholder="e.g. vault.example.testnet"
        />
        <Button type="submit" icon="search" disabled={m.isPending} className="md:mb-[1px]">
          {m.isPending ? "Checking…" : "Check keys"}
        </Button>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Live testnet agent:</span>
        <button
          type="button"
          title={`${LIVE.account}, vault ${LIVE.vault}`}
          onClick={() => {
            setAccount(LIVE.account);
            setVault(LIVE.vault);
            m.mutate(LIVE);
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink transition hover:border-link/60 hover:bg-surface-3"
        >
          <Icon name="lock" size={13} className="text-link" />
          Live demo agent keys
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-ink-2">
        You&apos;ll see: <span className="font-medium text-ink">FULL_ACCESS_PRESENT</span>. Our demo agent keeps a full-access key for simplicity; the result shows exactly how a
        production agent should be set up instead.
      </p>
      {m.isPending && <Loading label="Asking every provider…" />}
      {m.isError && (
        <div className="mt-3">
          <ErrorBox error={m.error} />
        </div>
      )}
      {r && <KeyAuditResult r={r} />}
    </Card>
  );
}

function KeyAuditResult({ r }: { r: KeyAudit }) {
  return (
    <div className="mt-5 space-y-4 animate-fade-up" aria-live="polite">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
        <span className={`grid h-9 w-9 place-items-center rounded-lg bg-surface-3 ${toneText[statusTone(r.status)]}`}>
          <Icon name={r.status === "LEAST_PRIVILEGE" ? "check" : r.status === "FULL_ACCESS_PRESENT" ? "alert" : "info"} size={17} />
        </span>
        <Pill tone={statusTone(r.status)}>{r.status}</Pill>
        <span className="text-sm text-ink">{r.reason}</span>
        {KEY_STATUS_HELP[r.status] && <span className="basis-full text-xs text-ink-2">{KEY_STATUS_HELP[r.status]}</span>}
      </div>
      {r.keys.length > 0 && (
        <>
          <p className="text-sm text-ink-2">
            <a className="font-mono text-link underline" href={explorerAccount(r.accountId)} target="_blank" rel="noreferrer">
              {r.accountId}
            </a>{" "}
            has {r.counts.fullAccess} full-access and {r.counts.functionCall} function-call key{r.counts.functionCall === 1 ? "" : "s"}.
          </p>
          <ul className="space-y-2" aria-label="Access keys">
            {r.keys.map((k) => (
              <li key={k.publicKey} className="rounded-xl border border-line bg-surface-2/40 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={riskTone(k.risk)}>{riskLabel(k.risk)}</Pill>
                  <span className="text-ink">{k.kind === "FULL_ACCESS" ? "Full-access key" : "Function-call key"}</span>
                  <code className="min-w-0 truncate font-mono text-[11px] text-muted" title={k.publicKey}>
                    {k.publicKey}
                  </code>
                </div>
                {k.kind === "FUNCTION_CALL" && (
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted">
                      Can call<Help label="can call">The only contract this key can call. A function-call key cannot transfer NEAR or attach a deposit.</Help>
                    </dt>
                    <dd className="font-mono text-ink-2">{k.receiverId}</dd>
                    <dt className="text-muted">Methods</dt>
                    <dd className="font-mono text-ink-2">{k.methodNames && k.methodNames.length ? k.methodNames.join(", ") : "all methods"}</dd>
                    <dt className="text-muted">
                      Gas allowance<Help label="gas allowance">How much NEAR this key may spend on transaction fees. “Unlimited” is NEAR&apos;s own recommendation for app keys: it only covers fees, never payments.</Help>
                    </dt>
                    <dd className="text-ink-2">{k.allowance === null ? "unlimited (fees only)" : `${nearOf(k.allowance)} NEAR`}</dd>
                  </dl>
                )}
                <p className="mt-2 text-xs text-ink-2">{k.why}</p>
                {k.fix && <p className="mt-1 text-xs text-ink">Fix: {k.fix}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.setup && r.setup.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-ink">
            Safe agent setup (run as the account owner with{" "}
            <a className="text-link underline" href="https://github.com/near/near-cli-rs" target="_blank" rel="noreferrer">
              near-cli-rs
            </a>
            ). Deleting an account&apos;s <strong>last</strong> full-access key is irreversible, so keep one offline with the owner, never on the agent&apos;s machine:
          </p>
          <CodeBlock title="1. give the agent a key that can only call spend · 2. take the full-access key off the agent">{r.setup.join("\n\n")}</CodeBlock>
        </div>
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
                <Pill tone={x.answer === "ERROR" ? "warning" : x.answer === "KEYS" ? "info" : "neutral"}>{x.answer}</Pill>
                {x.keyCount !== undefined && <span className="ml-2 text-xs text-muted">{x.keyCount} keys</span>}
                {x.error && <span className="ml-2 text-xs text-muted">{x.error}</span>}
              </td>
              <td className="py-1.5 text-right text-ink-2">{x.latencyMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
