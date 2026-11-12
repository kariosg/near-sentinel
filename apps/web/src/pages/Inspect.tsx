import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, type Diagnostic, type Inspection, type InspectInput } from "../api";
import { GuardPanel } from "../components/GuardPanel";
import { VaultPanel } from "../components/VaultPanel";
import { Icon } from "../components/icons";
import { DEMO_TXS, explorerTx, type DemoTx } from "../demoData";
import { ReceiptTree } from "../components/ReceiptTree";
import { Button, Card, download, Empty, ErrorBox, Field, fmtMs, linkClass, Loading, Mono, Pill, ProgressBar, stateTone, toneBg, toneText, VERDICTS, verdictTone } from "../components/ui";

/** Real testnet transactions (real-money demo + SDK test fixtures). Not mock data. */
const EXAMPLES = DEMO_TXS;

const VERDICT_TEXT: Record<string, string> = {
  DO_NOT_RETRY: "Do not retry",
  WAIT_AND_RECHECK: "Wait and re-check",
  SAFE_TO_RETRY: "Safe to retry",
  MANUAL_REVIEW_REQUIRED: "Manual review required",
};

function readQuery(): { hash?: string; sender?: string } {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const ex = EXAMPLES.find((e) => e.key === q.get("example"));
  if (ex) return { hash: ex.hash, sender: ex.sender };
  return { hash: q.get("hash") ?? undefined, sender: q.get("sender") ?? undefined };
}

export function InspectPage() {
  const initial = readQuery();
  const [mode, setMode] = useState<"hash" | "signed">("hash");
  const [hash, setHash] = useState(initial.hash ?? "");
  const [sender, setSender] = useState(initial.sender ?? "");
  const [signed, setSigned] = useState("");
  const m = useMutation({ mutationFn: (i: InspectInput) => api.inspect(i) });

  useEffect(() => {
    if (initial.hash && initial.sender) m.mutate({ transactionHash: initial.hash, senderAccountId: initial.sender });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (x: DemoTx) => {
    setMode("hash");
    setHash(x.hash);
    setSender(x.sender);
    m.mutate({ transactionHash: x.hash, senderAccountId: x.sender });
  };

  // The page stays mounted when only the ?example= query changes (e.g. from Ctrl+K), so react to it here.
  useEffect(() => {
    const on = () => {
      const key = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("example");
      const ex = EXAMPLES.find((e) => e.key === key);
      if (ex) pick(ex);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "hash") m.mutate({ transactionHash: hash.trim(), senderAccountId: sender.trim() });
    else m.mutate({ signedTransactionBase64: signed.trim() });
  };

  return (
    <div className="space-y-6">
      <nav aria-label="Tools on this page" className="rounded-xl border border-line bg-surface-2/50 px-4 py-3 text-sm text-ink-2">
        <span className="mr-1 font-medium text-ink">This page has 3 read-only tools:</span>
        <a className={linkClass} href="#/inspect" onClick={(e) => jump(e, "tool-check")}>
          ① Did my transaction land?
        </a>
        <span className="mx-1.5 text-muted">·</span>
        <a className={linkClass} href="#/inspect" onClick={(e) => jump(e, "tool-guard")}>
          ② Guard: was this intent already paid?
        </a>
        <span className="mx-1.5 text-muted">·</span>
        <a className={linkClass} href="#/inspect" onClick={(e) => jump(e, "tool-vault")}>
          ③ Vault: how much may this agent spend?
        </a>
      </nav>
      <div id="tool-check" className="scroll-mt-24">
      <Card title="Check a transaction" subtitle="Nothing is signed or sent. Sentinel only reads from public RPC providers." icon="search">
        <form onSubmit={submit} className="space-y-4">
          <div className="inline-flex rounded-xl border border-line bg-page/60 p-1 text-sm" role="tablist" aria-label="Input type">
            {(["hash", "signed"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={mode === k}
                onClick={() => setMode(k)}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 transition sm:px-3.5 ${mode === k ? "bg-surface-3 font-medium text-ink shadow" : "text-ink-2 hover:text-ink"}`}
              >
                {k === "hash" ? (
                  "Hash + sender"
                ) : (
                  <>
                    <span className="sm:hidden">Signed tx (definitive)</span>
                    <span className="hidden sm:inline">Signed transaction (definitive)</span>
                  </>
                )}
              </button>
            ))}
          </div>
          {mode === "hash" ? (
            <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
              <Field label="Transaction hash" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="base58, e.g. 9WeBPyuE9vC6…" required />
              <Field label="Sender account" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="e.g. alice.testnet" required />
            </div>
          ) : (
            <label className="block text-xs font-medium text-ink-2">
              Signed transaction (Base64-encoded Borsh). It contains a signature, never a private key. With it Sentinel can prove whether the transaction can still land
              (nonce + expiry + history coverage).
              <span className="mt-1 block font-normal text-muted">
                Where to get it: your agent already has these bytes. It is what it sent to the RPC (in near-api-js:{" "}
                <code className="font-mono">Buffer.from(signedTx.encode()).toString(&quot;base64&quot;)</code>). Keep them after a timeout and paste them here, or
                call the SDK; see{" "}
                <a className={linkClass} href="#/integrate">
                  Integrate
                </a>
                .
              </span>
              <textarea
                value={signed}
                onChange={(e) => setSigned(e.target.value)}
                rows={3}
                className="mt-1.5 w-full rounded-lg border border-line-strong bg-page/70 px-3 py-2.5 font-mono text-xs text-ink focus:border-link focus:outline-none focus:ring-2 focus:ring-link/30"
                required
              />
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" icon="search" disabled={m.isPending}>
              {m.isPending ? "Checking providers…" : "Inspect"}
            </Button>
          </div>
          {mode === "hash" && (
            <div className="space-y-3">
              <ExampleGroup
                title="Real-money demo on testnet (one click, no wallet)"
                items={EXAMPLES.filter((x) => x.group === "real-money")}
                onPick={pick}
              />
              <ExampleGroup title="Edge cases from real testnet" items={EXAMPLES.filter((x) => x.group === "edge-case")} onPick={pick} />
            </div>
          )}
        </form>
      </Card>
      </div>

      {m.isPending && <Querying />}
      {m.isError && <ErrorBox error={m.error} />}
      {m.data && <Result key={m.data.inspectedAt} r={m.data} />}
      {!m.data && !m.isPending && !m.isError && <Empty icon="search">Enter a transaction or pick an example. Nothing is signed or sent.</Empty>}

      <div id="tool-guard" className="scroll-mt-24">
        <GuardPanel />
      </div>
      <div id="tool-vault" className="scroll-mt-24">
        <VaultPanel />
      </div>
    </div>
  );
}

/** Jump to a section without changing the hash route. */
function jump(e: { preventDefault(): void }, id: string) {
  e.preventDefault();
  const el = document.getElementById(id);
  el?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  el?.querySelector<HTMLElement>("input, button, textarea")?.focus({ preventScroll: true });
}

/** Real testnet examples with a visible "you'll see" line (not hidden in a hover title, so touch users see it too). */
function ExampleGroup({ title, items, onPick }: { title: string; items: DemoTx[]; onPick: (x: DemoTx) => void }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{title}</p>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((x) => (
          <li key={x.key} className="rounded-xl border border-line bg-surface-2/50 p-2.5">
            <button
              type="button"
              aria-label={x.label}
              title={x.story}
              onClick={() => onPick(x)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2/60 px-3 py-1.5 text-xs font-medium text-ink transition hover:border-link/60 hover:bg-surface-3"
            >
              <Icon name={x.icon} size={13} className="text-link" />
              {x.label}
            </button>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-2">
              You&apos;ll see: <span className="font-medium text-ink">{x.expect}</span>
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">
              {x.story}{" "}
              <a className="text-link underline" href={explorerTx(x.hash)} target="_blank" rel="noreferrer">
                explorer
              </a>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** While the inspection runs: one animated row per configured provider. */
function Querying() {
  const providers = useQuery({ queryKey: ["providerHealth"], queryFn: api.providerHealth });
  const names = providers.data?.providers.map((p) => p.provider) ?? ["provider 1", "provider 2", "provider 3", "provider 4"];
  return (
    <div className="card rounded-2xl border border-line p-5 animate-fade-in">
      <Loading label="Querying every configured provider…" />
      <ul className="stagger grid gap-3 sm:grid-cols-2">
        {names.map((n) => (
          <li key={n} className="rounded-xl border border-line bg-surface-2/50 p-3">
            <p className="mb-2 flex items-center gap-2 text-sm text-ink-2">
              <Icon name="server" size={14} className="text-muted" /> {n}
            </p>
            <ProgressBar />
          </li>
        ))}
      </ul>
    </div>
  );
}

const CONFIDENCE: Record<string, number> = { high: 1, medium: 0.66, low: 0.33 };

function Result({ r }: { r: Inspection }) {
  const rec = r.retryRecommendation;
  const [showChecks, setShowChecks] = useState(false);
  const tone = verdictTone(rec.verdict);
  const meta = VERDICTS.find((v) => v.id === rec.verdict);
  const explorer = `https://${r.network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${r.txHash}`;
  return (
    <div className="space-y-6">
      <section className={`card relative overflow-hidden rounded-2xl border p-6 animate-scale-in ${tone === "good" ? "border-good/45" : tone === "critical" ? "border-critical/45" : tone === "serious" ? "border-serious/45" : "border-warning/45"}`}>
        <div aria-hidden className={`pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full opacity-[0.12] blur-3xl ${toneBg[tone]}`} />
        <div className="relative flex flex-wrap items-start gap-5">
          <span className={`relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-surface-2 ${toneText[tone]}`}>
            <span aria-hidden className={`absolute inset-0 rounded-2xl opacity-30 ${toneBg[tone]} animate-pulse-ring`} />
            <Icon name={meta?.icon ?? "info"} size={26} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <Pill tone={tone}>{rec.verdict}</Pill>
              <span className="text-xs text-muted">
                inspected {new Date(r.inspectedAt).toLocaleTimeString()} in {fmtMs(r.durationMs)} across {r.providers.length} provider{r.providers.length === 1 ? "" : "s"}
              </span>
            </div>
            <p className={`mt-2 text-2xl font-semibold tracking-tight ${toneText[tone]}`}>{VERDICT_TEXT[rec.verdict]}</p>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">{rec.reason}</p>
          </div>
          <div className="w-full sm:w-44">
            <p className="text-xs text-muted">
              confidence: <span className="font-medium text-ink-2">{rec.confidence}</span>
            </p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <div className={`h-full rounded-full ${toneBg[tone]} transition-all duration-1000`} style={{ width: `${(CONFIDENCE[rec.confidence] ?? 0.5) * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="relative mt-5 flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
          <Icon name="arrowRight" size={16} className="mt-0.5 text-link" />
          <p className="text-ink">
            <span className="font-semibold">Next:</span> {rec.nextAction}
            {rec.recheckAfterSeconds ? <span className="block text-xs text-muted">Re-check after ~{rec.recheckAfterSeconds}s.</span> : null}
          </p>
        </div>
        <button type="button" className={`relative mt-4 inline-flex items-center gap-1 text-xs ${linkClass}`} onClick={() => setShowChecks((s) => !s)} aria-expanded={showChecks}>
          <Icon name={showChecks ? "chevronDown" : "chevronRight"} size={13} />
          {showChecks ? "Hide" : "Show"} the {rec.checks.length} check{rec.checks.length === 1 ? "" : "s"} behind this verdict
        </button>
        {showChecks && (
          <ul className="stagger relative mt-3 space-y-1.5 text-xs">
            {rec.checks.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2/50 px-3 py-2">
                <Pill tone={c.passed === true ? "good" : c.passed === false ? "neutral" : "warning"}>{c.passed === null ? "n/a" : c.passed ? "yes" : "no"}</Pill>
                <Mono className="text-ink-2">{c.id}</Mono>
                <span className="text-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Transaction" icon="file">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">State</dt>
            <dd>
              <Pill tone={stateTone(r.state)}>{r.state}</Pill>
            </dd>
            <dt className="text-muted">Finality</dt>
            <dd className="text-ink-2">{r.finalExecutionStatus ?? "—"} {r.finalized && <span className="text-muted">(irreversible)</span>}</dd>
            <dt className="text-muted">Hash</dt>
            <dd>
              <Mono className="break-all text-ink-2">{r.txHash}</Mono>
            </dd>
            <dt className="text-muted">Signer → receiver</dt>
            <dd className="break-all text-ink-2">
              {r.senderAccountId} {r.transaction && <>→ {r.transaction.receiverId}</>}
            </dd>
            {r.transaction && (
              <>
                <dt className="text-muted">Nonce</dt>
                <dd>
                  <Mono className="text-ink-2">{r.transaction.nonce}</Mono>
                </dd>
                <dt className="text-muted">Actions</dt>
                <dd className="text-ink-2">{r.transaction.actions.map((a) => a.summary ?? a.type).join(", ")}</dd>
              </>
            )}
            <dt className="text-muted">Receipts</dt>
            <dd className="tabular text-ink-2">{r.receiptCount}</dd>
            <dt className="text-muted">Gas burnt</dt>
            <dd className="tabular text-ink-2">{(r.gasBurntTotal / 1e12).toFixed(3)} Tgas</dd>
            <dt className="text-muted">Fees (tokens burnt)</dt>
            <dd className="tabular text-ink-2">{(Number(BigInt(r.tokensBurntTotal) / 10n ** 15n) / 1e9).toFixed(6)} NEAR</dd>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href={explorer} target="_blank" rel="noreferrer" className={`text-xs ${linkClass}`}>
              Open in NearBlocks ↗
            </a>
            {r.reportId && (
              <a href={`/api/v1/reports/${r.reportId}`} target="_blank" rel="noreferrer" className={`text-xs ${linkClass}`}>
                Saved report (JSON) ↗
              </a>
            )}
            <button type="button" className={`text-xs ${linkClass}`} onClick={() => download(`sentinel-${r.txHash}.json`, r)}>
              Download full evidence
            </button>
          </div>
        </Card>

        <Card title={`Provider evidence — agreement: ${r.agreement}`} icon="server">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-1 font-normal">Provider</th>
                <th className="pb-1 font-normal">Answer</th>
                <th className="pb-1 font-normal">Finality</th>
                <th className="pb-1 text-right font-normal">Latency</th>
              </tr>
            </thead>
            <tbody>
              {r.providers.map((p) => (
                <tr key={p.provider} className="border-t border-line">
                  <td className="py-1.5">
                    <p className="text-ink">{p.provider}</p>
                    <p className="text-xs text-muted">{p.operator}</p>
                  </td>
                  <td className="py-1.5">
                    <Pill tone={p.outcome === "FOUND" ? "good" : p.outcome === "NOT_FOUND" ? "neutral" : "warning"} title={p.error?.message}>
                      {p.outcome === "ERROR" ? (p.error?.kind ?? "ERROR") : p.outcome}
                    </Pill>
                  </td>
                  <td className="py-1.5 text-xs text-ink-2">{p.finalExecutionStatus ?? "—"}</td>
                  <td className="py-1.5 text-right text-xs tabular text-ink-2">{fmtMs(p.latencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            Each row is one raw <Mono>EXPERIMENTAL_tx_status</Mono> answer ({r.observations.length} observations total, all in the downloadable evidence).
          </p>
        </Card>
      </div>

      <Card title={`Diagnostics (${r.diagnostics.length})`} icon="activity">
        {r.diagnostics.length === 0 ? <Empty>No problems found.</Empty> : <Diagnostics items={r.diagnostics} />}
      </Card>

      <Card title="Receipt execution graph" icon="layers" subtitle="Every receipt the transaction produced, with failures highlighted">
        {r.receiptTree ? <ReceiptTree root={r.receiptTree} txHash={r.txHash} network={r.network} /> : <Empty>No provider has this transaction, so there are no receipts to show.</Empty>}
      </Card>
    </div>
  );
}

function Diagnostics({ items }: { items: Diagnostic[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="space-y-2">
      {items.map((d, i) => (
        <li key={i} className="rounded-xl border border-line bg-surface-2/60 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Mono className="text-muted">{d.code}</Mono>
            <span className="text-sm font-medium text-ink">{d.title}</span>
            <span className="ml-auto flex gap-2">
              <Pill tone="neutral">confidence {d.confidence}</Pill>
              <Pill tone={d.retry === "safe" ? "good" : d.retry === "unsafe" ? "critical" : "warning"}>retry {d.retry}</Pill>
            </span>
          </div>
          <p className="mt-1.5 text-sm text-ink-2">{d.explanation}</p>
          <p className="mt-1 text-sm text-ink">
            <span className="text-muted">Suggested:</span> {d.suggestedAction}
          </p>
          {d.evidence.length > 0 && (
            <>
              <button type="button" className={`mt-2 text-xs ${linkClass}`} onClick={() => setOpen(open === i ? null : i)}>
                {open === i ? "Hide" : "Show"} evidence ({d.evidence.length})
              </button>
              {open === i && (
                <ul className="mt-2 space-y-1 text-xs text-ink-2">
                  {d.evidence.map((e, j) => (
                    <li key={j}>
                      • {e.claim}
                      {e.receiptId && (
                        <>
                          {" "}
                          — receipt <Mono>{e.receiptId}</Mono>
                        </>
                      )}
                      {e.excerpt !== undefined && <pre className="mt-1 max-h-32 overflow-auto rounded bg-page p-2 font-mono text-[11px]">{JSON.stringify(e.excerpt, null, 1)}</pre>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
