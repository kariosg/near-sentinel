import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/icons";
import { linkClass, Pill, toneText, verdictTone, type Tone } from "../components/ui";

/**
 * "How it works, in charts": the real problem, the layer that solves it, the proof, NEAR vs EVM, the evidence and the
 * live wallet test. Every number here comes from the repo docs (README, JUDGING.md, docs/STATUS.md, docs/AUDIT.md,
 * docs/manual-wallet-test-2026-11-13.md). Static content: no API calls.
 */

const NEARBLOCKS = "https://testnet.nearblocks.io/txns/";

const SECTIONS = [
  { id: "hiw-problem", n: 1, short: "The problem" },
  { id: "hiw-layers", n: 2, short: "Problem → layer → proof" },
  { id: "hiw-flow", n: 3, short: "The 4 layers" },
  { id: "hiw-near", n: 4, short: "NEAR vs EVM" },
  { id: "hiw-evidence", n: 5, short: "Evidence" },
  { id: "hiw-wallet", n: 6, short: "Live wallet test" },
] as const;

const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/* ------------------------------------------------------------------ small building blocks */

/** A NearBlocks (testnet) transaction link: short hash, opens in a new tab. */
function Tx({ hash, label }: { hash: string; label?: string }) {
  return (
    <a
      href={`${NEARBLOCKS}${hash}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`${label ? `${label}: ` : ""}transaction ${hash.slice(0, 8)} on NearBlocks (opens in a new tab)`}
      className={`inline-flex items-center gap-1 font-mono text-xs ${linkClass}`}
    >
      {hash.slice(0, 8)}…
      <Icon name="external" size={12} />
    </a>
  );
}

/** A transaction we only know by its short prefix (no link). */
function TxPrefix({ children }: { children: string }) {
  return <span className="whitespace-nowrap font-mono text-xs text-ink-2">{children}…</span>;
}

/** In-app deep link ("Try it: …"). */
function TryIt({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-xs font-medium text-ink-2 transition hover:border-link/60 hover:bg-surface-2 hover:text-ink"
    >
      <Icon name="play" size={11} className="text-link" />
      {children}
    </a>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-3/70 px-1 py-px font-mono text-[0.85em] text-ink">{children}</code>;
}

/** Verdict / action chip, coloured with the app's verdict tones (icon + text, never colour alone). */
function V({ id, tone }: { id: string; tone?: Tone }) {
  return (
    <span className="font-mono">
      <Pill tone={tone ?? verdictTone(id)}>{id}</Pill>
    </span>
  );
}

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card rounded-2xl border border-line p-5 sm:p-6 ${className}`}>{children}</div>;
}

function Step({ n, id, title, sub, children }: { n: number; id: string; title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <div className="mb-5 flex items-start gap-3.5">
        <span
          aria-hidden
          className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-b from-accent to-accent-2 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgb(37_99_235/0.9)]"
        >
          {n}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">Step {n} of 6</p>
          <h2 id={`${id}-title`} className="mt-1 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            {title}
          </h2>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-ink-2">{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ charts */

type Bar = { name: string; value: number; display: string; tone?: "series" | "good" | "critical"; before?: number; detail?: string };
const barFill = { series: "bg-series-1", good: "bg-good", critical: "bg-critical" } as const;

/**
 * Horizontal bar chart in plain HTML/CSS: thin bars from a shared zero baseline, 4px rounded data end, value label
 * at the end of each row, optional "before" tick. The whole chart is one image for screen readers (aria-label lists
 * every value); each row also has a hover title with its exact value.
 */
function BarChart({ label, bars, max, note }: { label: string; bars: Bar[]; max: number; note?: ReactNode }) {
  const summary = `${label}: ${bars.map((b) => `${b.name} ${b.display}${b.before !== undefined ? ` (was ${b.before})` : ""}`).join("; ")}.`;
  return (
    <figure className="m-0">
      <div role="img" aria-label={summary} className="space-y-2.5">
        {bars.map((b) => (
          <div
            key={b.name}
            title={b.detail ?? `${b.name}: ${b.display}`}
            className="group grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]"
          >
            <span className="truncate text-xs text-ink-2 group-hover:text-ink sm:text-[13px]">{b.name}</span>
            <span className="relative h-2.5 rounded-sm border-l-2 border-axis bg-surface-3/60">
              <span
                className={`absolute inset-y-0 left-0 rounded-r-[4px] transition-[filter] group-hover:brightness-125 ${barFill[b.tone ?? "series"]}`}
                style={{ width: `${Math.max(0, Math.min(100, (b.value / max) * 100))}%` }}
              />
              {b.before !== undefined && (
                <span className="absolute -inset-y-1 w-0.5 rounded bg-ink-2" style={{ left: `calc(${(b.before / max) * 100}% - 1px)` }} />
              )}
            </span>
            <span className="min-w-[3.25rem] text-right text-[13px] font-semibold tabular text-ink">{b.display}</span>
          </div>
        ))}
      </div>
      {note && <figcaption className="mt-3.5 text-xs leading-relaxed text-muted">{note}</figcaption>}
    </figure>
  );
}

function StatTile({ value, label, tone }: { value: string; label: ReactNode; tone?: Tone }) {
  return (
    <div className="card rounded-2xl border border-line px-5 py-4">
      <p className={`text-3xl font-semibold tracking-tight tabular ${tone ? toneText[tone] : "text-ink"}`}>{value}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{label}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ data (from the repo docs) */

const LANES = [
  {
    who: "Naive agent",
    how: "guesses",
    tone: "critical" as const,
    icon: "alert" as IconName,
    steps: [
      { t: "Sign payment #1", d: "1 NEAR to the shop" },
      { t: "RPC timeout", d: "No answer. It actually landed.", tone: "warning" as const },
      { t: "“It failed”", d: "Signs NEW bytes" },
      { t: "Payment #2 lands", d: "Paid twice", tone: "critical" as const },
    ],
    result: "2 NEAR",
    resultSub: "paid for a 1 NEAR order",
  },
  {
    who: "Sentinel-guarded agent",
    how: "asks first",
    tone: "good" as const,
    icon: "shieldCheck" as IconName,
    steps: [
      { t: "Sign payment #1", d: "1 NEAR to the shop" },
      { t: "RPC timeout", d: "No answer. It actually landed.", tone: "warning" as const },
      { t: "Ask Sentinel", d: "4 providers, 3 independent operators" },
      { t: "DO_NOT_RETRY", d: "It landed. Stop.", tone: "good" as const },
    ],
    result: "1 NEAR",
    resultSub: "paid once, as intended",
  },
];

type Row = { problem: string; layer: ReactNode; proof: ReactNode; tryIt?: { href: string; label: string } };
const ROWS: Row[] = [
  {
    problem: "RPC timeout → pay twice or lose the payment",
    layer: (
      <>
        Retry verdict: <V id="DO_NOT_RETRY" /> or <V id="SAFE_TO_RETRY" />. SAFE needs the nonce used or the validity window expired, on ≥ 2 independent operators.
      </>
    ),
    proof: (
      <>
        Naive 2×, guarded 1× (real testnet). Unsent tx: WAIT, then SAFE after its nonce was used (<Tx hash="6jM2toRMAb9KDNTSNHrCVSGEY5ttJenXnAiirBPE7wnj" label="Nonce proof" />).
      </>
    ),
    tryIt: { href: "#/inspect?example=guarded", label: "Inspect the guarded payment" },
  },
  {
    problem: "A provider lies or lags behind",
    layer: <>Multi-provider cross-check (FastNEAR, dRPC, Intear). Each node must show the whole proof itself. “Unknown” is never “safe”.</>,
    proof: <>Fault benchmark 12/12, incl. stale and inconsistent providers. Test: a lagging load-balanced node never gives SAFE.</>,
    tryIt: { href: "#/benchmarks", label: "Benchmarks" },
  },
  {
    problem: "“Success” on top, failure hidden below",
    layer: (
      <>
        Receipt tree walk → <V id="MANUAL_REVIEW_REQUIRED" />
      </>
    ),
    proof: (
      <>
        Real tx <Tx hash="EtpgCjJPA1WN9MxG17C88GtEU5kf6mx77YxhrWdjMuBd" label="Partial execution" />: <Code>run_buyback</Code> succeeded, <Code>ft_burn</Code> and{" "}
        <Code>ft_transfer_call</Code> panicked.
      </>
    ),
    tryIt: { href: "#/inspect?example=partial", label: "Inspect this tx" },
  },
  {
    problem: "Duplicate payment on retry",
    layer: (
      <>
        Guard contract: one intent is paid at most once, on-chain. Duplicate → <Code>DUPLICATE_INTENT</Code>, deposit refunded.
      </>
    ),
    proof: (
      <>
        <Code>guard.karios.testnet</Code>: live suite 11/11; real pay-once with refund (<TxPrefix>BwuNp2Vq</TxPrefix>, <TxPrefix>Av16fn4B</TxPrefix>).
      </>
    ),
    tryIt: { href: "#/inspect?tool=guard", label: "Inspect → ② Guard" },
  },
  {
    problem: "Agent has too much power, or its key leaks",
    layer: (
      <>
        Vault: per-payment and 24 h limits, receiver allowlist, freeze, owner-only withdraw. Agent holds a function-call key that can only call <Code>spend</Code>.
      </>
    ),
    proof: (
      <>
        Sandbox: NEAR rejects that key for any other use (<Code>INVALID_TRANSACTION</Code>). <Code>vault.karios.testnet</Code> live suite 10/10.
      </>
    ),
    tryIt: { href: "#/inspect?tool=vault", label: "Inspect → ③ Vault" },
  },
  {
    problem: "Prompt-injected agent, scam lookalike payee",
    layer: (
      <>
        Preflight → <V id="SIGN" tone="good" /> <V id="ASK_HUMAN" tone="warning" /> <V id="REFUSE" tone="critical" />, with receiver check (<Code>kari0s</Code> vs <Code>karios</Code> →
        DANGER). <Code>guardedSpend</Code> never signs on REFUSE.
      </>
    ),
    proof: <>Injection demo: naive signed 3/3 attacker payments, guarded 0/3. Real testnet: 10/10 predictions matched the contract, twice.</>,
    tryIt: { href: "#/inspect?tool=vault", label: "Inspect → ③ Vault" },
  },
];

const FAULTS = [
  "artificial latency",
  "timeout (no answer)",
  "connection reset",
  "malformed JSON",
  "rate limited (429)",
  "oversized response",
  "bad gateway (502)",
  "stale (lying) provider",
  "providers disagree",
  "missing receipt",
  "delayed outcome",
  "downstream failure",
];

const TEST_SUITES: Bar[] = [
  { name: "SDK unit", value: 346, display: "346" },
  { name: "API", value: 87, display: "87" },
  { name: "Browser (Playwright)", value: 62, display: "62" },
  { name: "Contract unit (Rust)", value: 33, display: "33", detail: "Rust unit: 33 (Guard 14 + Vault 19)" },
  { name: "On-chain sandbox", value: 27, display: "27", detail: "Sandbox: 27 (Vault 14 + Guard 13)" },
  { name: "Live testnet contracts", value: 21, display: "21", detail: "Live testnet: 21 (Guard 11 + Vault 10)" },
  { name: "MCP end-to-end", value: 17, display: "17" },
  { name: "Demo assertions", value: 12, display: "12" },
  { name: "Live RPC (read-only)", value: 10, display: "10", detail: "Live testnet + mainnet: 10" },
  { name: "NEAR AI agent", value: 9, display: "9", detail: "NEAR AI agent (offline): 9" },
];

const LIGHTHOUSE: Bar[] = [
  { name: "Performance, mobile", value: 93, display: "93", before: 78, detail: "Mobile performance: 93 (was 78 before the fixes)" },
  { name: "Performance, desktop", value: 96, display: "96", before: 93, detail: "Desktop performance: 96 (was 93 before the fixes)" },
  { name: "Accessibility", value: 100, display: "100" },
  { name: "Best practices", value: 100, display: "100" },
  { name: "SEO", value: 100, display: "100" },
];

const COMPARE = [
  { aspect: "Execution", evm: "Atomic, in one block", near: "Async receipts, can span shards and blocks", sentinel: "Follows every receipt until final" },
  { aspect: "Result", evm: "One receipt: success or revert", near: "A receipt tree: top “success” can hide a failure", sentinel: "Walks the tree → MANUAL_REVIEW_REQUIRED" },
  { aspect: "Nonce", evm: "One nonce per account", near: "One nonce per access key, plus a validity window", sentinel: "Uses key nonce + window to prove “never lands”" },
  {
    aspect: "Keys",
    evm: "No built-in limited keys (smart wallets can add them)",
    near: "Built-in function-call keys (one contract, chosen methods)",
    sentinel: "Vault: agent key can only call spend",
  },
  { aspect: "Timeout problem", evm: "Yes", near: "Yes", sentinel: "Same question everywhere: did it land?" },
];

const WALLET_STEPS: Array<{ title: string; state: { id: string; tone: Tone }; lines: ReactNode[]; tx: string }> = [
  {
    title: "Set policy + fund",
    state: { id: "ACTIVE", tone: "good" },
    lines: ["0.01 NEAR per payment, 0.02 NEAR per 24 h, deposit 0.05 NEAR", "ACTIVE on 4/4 providers"],
    tx: "9QQMcG6iZN745J4QzG7gJVfGUWFAuTzRFr9sgogtESfR",
  },
  {
    title: "Freeze",
    state: { id: "FROZEN", tone: "critical" },
    lines: [
      <>
        Preflight: BLOCKED · FROZEN → <V id="REFUSE" tone="critical" />
      </>,
    ],
    tx: "EJvUd8x8aRcCgcYvS4SoPLTMq7pFVcX39UH9YoWtsGrH",
  },
  {
    title: "Unfreeze",
    state: { id: "ACTIVE", tone: "good" },
    lines: ["ACTIVE again", "The agent may pay within limits"],
    tx: "93xZCmtPGNNpEzosmoH7RXA7bMoKHPmisEKCmdbRKfkP",
  },
  {
    title: "Withdraw Max",
    state: { id: "balance 0", tone: "neutral" },
    lines: ["0.04839 NEAR back to the owner", "Vault balance: 0. Funds returned."],
    tx: "E2NgiPZ25UVrMfutFZKApNh6pVbF99ZUoCydkXDa6PMi",
  },
];

/* ------------------------------------------------------------------ page */

export function HowItWorksPage() {
  return (
    <div className="space-y-14">
      {/* ------------------------------------------------------------ intro */}
      <section aria-labelledby="hiw-intro-title" className="card glow-border overflow-hidden rounded-2xl border border-line p-5 sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">The question every paying agent hits</p>
        <h2 id="hiw-intro-title" className="mt-2 text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
          <span className="text-ink">The RPC timed out.</span> <span className="text-gradient">Did the payment land?</span>
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-2 sm:text-base">
          An AI agent pays on NEAR. Sometimes the answer never comes back. NEAR Sentinel checks the chain on several independent providers and tells the agent what to
          do next, with proof, before it signs anything new.
        </p>
        <ul aria-label="The four verdicts" className="mt-5 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["DO_NOT_RETRY", "It landed. Do not pay again."],
            ["WAIT_AND_RECHECK", "It can still land. Re-send the same bytes."],
            ["SAFE_TO_RETRY", "Proven it can never land."],
            ["MANUAL_REVIEW_REQUIRED", "Only partly done."],
          ].map(([id, text]) => (
            <li key={id} className="rounded-xl border border-line bg-surface-2/60 px-3.5 py-3">
              <V id={id!} />
              <p className="mt-1.5 text-[13px] text-ink-2">{text}</p>
            </li>
          ))}
        </ul>
        <nav aria-label="On this page" className="mt-6 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">On this page</p>
          <ol className="flex flex-wrap gap-2">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => scrollTo(s.id)}
                  className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface-2/50 py-1 pl-1 pr-3 text-xs text-ink-2 transition hover:border-link/60 hover:text-ink"
                >
                  <span aria-hidden className="grid h-5 w-5 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-ink">
                    {s.n}
                  </span>
                  {s.short}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </section>

      {/* ------------------------------------------------------------ in one minute */}
      <section aria-labelledby="hiw-minute-title">
        <h2 id="hiw-minute-title" className="mb-4 text-lg font-semibold tracking-tight text-ink">
          In one minute
        </h2>
        <ul className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              icon: "alert" as IconName,
              tone: "critical" as Tone,
              title: "The problem",
              text: "The agent sends 1 NEAR and the RPC times out. Retry and it may pay twice; give up and the payment may be lost. A timeout does not mean it failed.",
            },
            {
              icon: "shieldCheck" as IconName,
              tone: "info" as Tone,
              title: "What Sentinel does",
              text: "Asks 4 providers run by 3 independent operators what really happened, and answers with one of four verdicts, with proof, before the agent signs anything new.",
            },
            {
              icon: "check" as IconName,
              tone: "good" as Tone,
              title: "The proof",
              text: "Real testnet money: the naive agent paid 2 NEAR, the guarded one 1 NEAR. Fault benchmark 12/12. Prompt injection: 0/3 attacker payments signed.",
            },
            {
              icon: "layers" as IconName,
              tone: "warning" as Tone,
              title: "Why NEAR",
              text: "Receipts run async across shards, so a top-level “success” can hide a failure. Key nonces, validity windows and function-call keys let Sentinel prove what happened.",
            },
          ].map((c) => (
            <li key={c.title} className="card rounded-2xl border border-line p-5">
              <span aria-hidden className={`grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface-2 ${toneText[c.tone]}`}>
                <Icon name={c.icon} size={18} />
              </span>
              <h3 className="mt-3.5 font-semibold text-ink">{c.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{c.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------ 1. problem */}
      <Step
        n={1}
        id="hiw-problem"
        title="The real-life problem"
        sub={
          <>
            The agent sends 1 NEAR. The RPC times out. Retry and it may pay twice. Give up and the payment may be lost. A timeout does <strong className="text-ink">not</strong>{" "}
            mean it failed.
          </>
        }
      >
        <div className="space-y-4">
          {LANES.map((lane) => (
            <div key={lane.who} className={`card rounded-2xl border p-4 sm:p-5 ${lane.tone === "good" ? "border-good/30" : "border-critical/30"}`}>
              <div className="@container">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h3 className="flex items-center gap-2.5 font-semibold text-ink">
                    <span aria-hidden className={`grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface-2 ${toneText[lane.tone]}`}>
                      <Icon name={lane.icon} size={16} />
                    </span>
                    <span>
                      {lane.who}
                      <span className="block text-xs font-normal text-muted">{lane.how}</span>
                    </span>
                  </h3>
                  <p className={`flex items-baseline gap-2 ${toneText[lane.tone]}`}>
                    <span className="text-2xl font-semibold tracking-tight tabular sm:text-3xl">{lane.result}</span>
                    <span className="text-xs text-muted">{lane.resultSub}</span>
                  </p>
                </div>
                <ol aria-label={`${lane.who}: steps`} className="mt-4 grid gap-2.5 @md:grid-cols-2 @3xl:grid-cols-4 @3xl:gap-4">
                  {lane.steps.map((s, i) => {
                    const border =
                      s.tone === "critical" ? "border-critical/50 bg-critical/10" : s.tone === "good" ? "border-good/50 bg-good/10" : s.tone === "warning" ? "border-warning/45 bg-warning/10" : "border-line-strong bg-surface-2/70";
                    return (
                      <li key={s.t} className={`relative rounded-xl border px-3 py-2.5 ${border}`}>
                        <p className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                          <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-page/60 text-[10px] text-ink-2">
                            {i + 1}
                          </span>
                          <span className={s.t === "DO_NOT_RETRY" ? "font-mono" : ""}>{s.t}</span>
                        </p>
                        <p className="mt-1 pl-7 text-xs text-ink-2">{s.d}</p>
                        {i < lane.steps.length - 1 && (
                          <span aria-hidden className="absolute -right-[0.95rem] top-1/2 z-10 hidden -translate-y-1/2 text-muted @3xl:block">
                            <Icon name="chevronRight" size={16} />
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel>
            <h3 className="mb-4 font-semibold text-ink">Paid for one 1 NEAR order</h3>
            <BarChart
              label="NEAR paid for one 1 NEAR order"
              max={2}
              bars={[
                { name: "Naive agent", value: 2, display: "2 NEAR", tone: "critical" },
                { name: "Guarded agent", value: 1, display: "1 NEAR", tone: "good" },
              ]}
              note={
                <>
                  Amounts from <Code>pnpm demo</Code> (merchant received 2 NEAR vs 1, intended 1). The other failure mode is also covered: the payment was dropped,
                  Sentinel says WAIT_AND_RECHECK, the agent re-sends the <em>same</em> bytes and still pays once.
                </>
              }
            />
          </Panel>
          <Panel>
            <h3 className="mb-3 font-semibold text-ink">Real money on NEAR testnet (2026-11-11)</h3>
            <ul className="divide-y divide-line text-sm">
              {[
                { label: "Naive, payment 1", hash: "185YtdJZxUCMAaqjRtmSj4MTx51mdiMpjhAPmZ3rZaH", tone: "critical" as Tone },
                { label: "Naive, payment 2 (duplicate)", hash: "6h2hMxjpjdYwDF6zXJ5gTwD5MY47UT7thdRaxZM2Pc6h", tone: "critical" as Tone },
                { label: "Guarded, only payment", hash: "C59gttNUHCaVTHVi2GKCw6zu5C7QcmwPbUuw9NeaXnzS", tone: "good" as Tone },
                { label: "Nonce proof (unsent tx → SAFE)", hash: "6jM2toRMAb9KDNTSNHrCVSGEY5ttJenXnAiirBPE7wnj", tone: "info" as Tone },
              ].map((t) => (
                <li key={t.hash} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
                  <span className="flex items-center gap-2 text-ink-2">
                    <span aria-hidden className={`h-2 w-2 rounded-full ${t.tone === "critical" ? "bg-critical" : t.tone === "good" ? "bg-good" : "bg-info"}`} />
                    {t.label}
                  </span>
                  <Tx hash={t.hash} label={t.label} />
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Links open NearBlocks (testnet). Re-run: <Code>pnpm demo:testnet</Code>, <Code>pnpm demo:critical</Code> (5/5).
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <TryIt href="#/inspect?example=guarded">Inspect the guarded payment</TryIt>
              <TryIt href="#/inspect?example=naive2">Inspect the duplicate</TryIt>
            </div>
          </Panel>
        </div>
      </Step>

      {/* ------------------------------------------------------------ 2. problem → layer → proof */}
      <Step n={2} id="hiw-layers" title="Real-life problem → Sentinel layer → proof" sub="Each problem has one layer that solves it, and a result you can check.">
        {/* Phones: one card per problem. */}
        <ul className="space-y-3 md:hidden">
          {ROWS.map((r) => (
            <li key={r.problem} className="card rounded-2xl border border-line p-4">
              <h3 className="flex items-start gap-2 text-sm font-semibold text-ink">
                <Icon name="alert" size={15} className="mt-0.5 text-critical" />
                {r.problem}
              </h3>
              <dl className="mt-3 space-y-2.5 text-[13px] leading-relaxed">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Layer that solves it</dt>
                  <dd className="mt-0.5 text-ink-2">{r.layer}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Proof</dt>
                  <dd className="mt-0.5 text-ink-2">{r.proof}</dd>
                </div>
              </dl>
              {r.tryIt && (
                <div className="mt-3">
                  <TryIt href={r.tryIt.href}>{r.tryIt.label}</TryIt>
                </div>
              )}
            </li>
          ))}
        </ul>
        {/* Tablet and up: a real table. */}
        <div className="card hidden overflow-hidden rounded-2xl border border-line px-5 md:block">
          <table className="w-full table-fixed text-left text-[13px] leading-relaxed">
            <caption className="sr-only">Real-life problem, the Sentinel layer that solves it, and the proof</caption>
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="w-[26%] py-3 font-semibold">
                  Real-life problem
                </th>
                <th scope="col" className="w-[38%] py-3 font-semibold">
                  Sentinel layer that solves it
                </th>
                <th scope="col" className="py-3 font-semibold">
                  Proof
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.problem} className="border-t border-line align-top">
                  <th scope="row" className="py-3.5 font-semibold text-ink">
                    <span className="flex items-start gap-2">
                      <Icon name="alert" size={14} className="mt-1 text-critical" />
                      {r.problem}
                    </span>
                  </th>
                  <td className="py-3.5 text-ink-2">{r.layer}</td>
                  <td className="py-3.5 text-ink-2">
                    {r.proof}
                    {r.tryIt && (
                      <div className="mt-2">
                        <TryIt href={r.tryIt.href}>{r.tryIt.label}</TryIt>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Step>

      {/* ------------------------------------------------------------ 3. flow */}
      <Step n={3} id="hiw-flow" title="How one payment flows through the 4 layers" sub="The AI model can be fooled. The layers below it cannot be talked out of their rules.">
        <Panel>
          <ol aria-label="Payment flow" className="relative space-y-4">
            <FlowNode kind="start" title="AI agent wants to pay" sub="e.g. it read an invoice (maybe a poisoned one)" />
            <FlowNode n="1" title="Preflight check" sub="Vault rules in contract order + receiver scam check" />
            <FlowNode
              n="2"
              title="guardedSpend action"
              sub="SIGN / ASK_HUMAN / REFUSE, whatever the model says"
              branches={[
                { chip: <V id="REFUSE" tone="critical" />, text: "Never signed. The money stays." },
                { chip: <V id="ASK_HUMAN" tone="warning" />, text: "Human yes → SIGN; no answer → refuse." },
                { chip: <V id="SIGN" tone="good" />, text: "Continues to the vault ↓" },
              ]}
            />
            <FlowNode
              n="3"
              title="Vault spend(intent), on-chain"
              sub="Limits · allowlist · freeze · pay once per intent"
              aside="Agent key = function-call key: only “spend”, within the owner’s limits. A leaked key cannot drain it."
              tryIt={{ href: "#/inspect?tool=vault", label: "Inspect → ③ Vault" }}
            />
            <FlowNode
              kind="question"
              title="RPC answered?"
              branches={[
                { chip: <Pill tone="good">yes</Pill>, text: "Paid once. Done." },
                { chip: <Pill tone="warning">timeout / no answer</Pill>, text: "Ask Sentinel ↓" },
              ]}
            />
            <FlowNode
              n="4"
              last
              title="Sentinel verdict, across providers"
              sub="4 providers, 3 independent operators · nonce · validity window · receipts"
              tryIt={{ href: "#/inspect", label: "Inspect → ① Did my transaction land?" }}
            />
          </ol>
          <ul aria-label="Possible verdicts" className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { id: "DO_NOT_RETRY", a: "It landed.", b: "Paying again = double pay." },
              { id: "WAIT_AND_RECHECK", a: "It can still land.", b: "Re-send the same bytes only." },
              { id: "SAFE_TO_RETRY", a: "Proven: it can never land.", b: "Nonce used or window expired." },
              { id: "MANUAL_REVIEW_REQUIRED", a: "Only partly done.", b: "A downstream receipt failed." },
            ].map((v) => (
              <li key={v.id} className={`rounded-xl border bg-surface-2/50 p-3.5 ${borderFor(verdictTone(v.id))}`}>
                <V id={v.id} />
                <p className="mt-2 text-sm font-medium text-ink">{v.a}</p>
                <p className="mt-0.5 text-xs text-ink-2">{v.b}</p>
              </li>
            ))}
          </ul>
        </Panel>
      </Step>

      {/* ------------------------------------------------------------ 4. NEAR vs EVM */}
      <Step
        n={4}
        id="hiw-near"
        title="Why this is harder on NEAR than on EVM"
        sub={
          <>
            Honest note: the timeout problem exists on <strong className="text-ink">every</strong> chain. NEAR adds more moving parts, and also gives better tools to prove
            what happened.
          </>
        }
      >
        <div className="grid items-start gap-4 lg:grid-cols-[2fr_3fr]">
          <Panel>
            <h3 className="font-semibold text-ink">
              EVM <span className="text-sm font-normal text-muted">(e.g. Ethereum) · one step</span>
            </h3>
            <ol aria-label="EVM execution" className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <Box>Transaction</Box>
              <Arrow />
              <Box sub="all or nothing">One block</Box>
              <Arrow />
              <Box tone="good">1 receipt</Box>
            </ol>
          </Panel>
          <Panel>
            <h3 className="font-semibold text-ink">
              NEAR <span className="text-sm font-normal text-muted">· async receipts across shards</span>
            </h3>
            <ol aria-label="NEAR execution of a real testnet transaction" className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <Box>Transaction</Box>
              <Arrow />
              <Box tone="good" sub="success (top)" mono>
                run_buyback
              </Box>
              <Arrow />
              <li className="flex flex-1 flex-col gap-2">
                <ul className="flex flex-1 flex-col gap-2">
                  <Box tone="critical" sub="shard X · panicked" mono>
                    ft_burn
                  </Box>
                  <Box tone="critical" sub="shard Y · panicked" mono>
                    ft_transfer_call
                  </Box>
                </ul>
              </li>
            </ol>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Real testnet tx <Tx hash="EtpgCjJPA1WN9MxG17C88GtEU5kf6mx77YxhrWdjMuBd" label="Partial execution" /> → Sentinel says MANUAL_REVIEW_REQUIRED, not “done”.
            </p>
            <div className="mt-3">
              <TryIt href="#/inspect?example=partial">Inspect this tx</TryIt>
            </div>
          </Panel>
        </div>

        {/* Phones: one card per aspect. */}
        <ul className="mt-4 space-y-3 md:hidden">
          {COMPARE.map((c) => (
            <li key={c.aspect} className="card rounded-2xl border border-line p-4">
              <h3 className="text-sm font-semibold text-ink">{c.aspect}</h3>
              <dl className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-relaxed">
                <dt className="text-muted">EVM</dt>
                <dd className={c.evm === "Yes" ? "text-warning" : "text-ink-2"}>{c.evm}</dd>
                <dt className="text-muted">NEAR</dt>
                <dd className={c.near === "Yes" ? "text-warning" : "text-ink-2"}>{c.near}</dd>
                <dt className="text-muted">Sentinel</dt>
                <dd className="text-ink">{c.sentinel}</dd>
              </dl>
            </li>
          ))}
        </ul>
        <div className="card mt-4 hidden overflow-hidden rounded-2xl border border-line px-5 md:block">
          <table className="w-full table-fixed text-left text-[13px] leading-relaxed">
            <caption className="sr-only">EVM compared with NEAR, and what Sentinel does</caption>
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="w-[16%] py-3 font-semibold">
                  <span className="sr-only">Aspect</span>
                </th>
                <th scope="col" className="w-[26%] py-3 font-semibold">
                  EVM
                </th>
                <th scope="col" className="w-[30%] py-3 font-semibold">
                  NEAR
                </th>
                <th scope="col" className="py-3 font-semibold">
                  What Sentinel does
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((c) => (
                <tr key={c.aspect} className="border-t border-line align-top">
                  <th scope="row" className="py-3 font-semibold text-ink">
                    {c.aspect}
                  </th>
                  <td className={`py-3 ${c.evm === "Yes" ? "text-warning" : "text-ink-2"}`}>{c.evm}</td>
                  <td className={`py-3 ${c.near === "Yes" ? "text-warning" : "text-ink-2"}`}>{c.near}</td>
                  <td className="py-3 text-ink">{c.sentinel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Step>

      {/* ------------------------------------------------------------ 5. evidence */}
      <Step n={5} id="hiw-evidence" title="Evidence in numbers" sub="All numbers are from the repo docs (README, JUDGING.md, docs/STATUS.md, docs/AUDIT.md). Hover a bar for its exact value.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile value="12/12" tone="good" label="fault scenarios classified correctly (simulated benchmark)" />
          <StatTile value="471" label={<>unit and integration tests (<Code>pnpm test</Code>)</>} />
          <StatTile value="62" label="browser tests, with axe accessibility checks" />
          <StatTile value="10/10" tone="good" label="real testnet payment predictions matched the contract, on 2 separate runs" />
        </div>

        <Panel className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-ink">Fault benchmark: 12 of 12 correct</h3>
            <TryIt href="#/benchmarks?run=simulated">Run the 12 scenarios yourself</TryIt>
          </div>
          <ul aria-label="Fault scenarios, all classified correctly" className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
            {FAULTS.map((f) => (
              <li key={f} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-2.5 py-2 text-xs text-ink-2 sm:px-3 sm:text-[13px]">
                <Icon name="check" size={14} className="text-good" />
                <span>
                  {f}
                  <span className="sr-only"> (correct)</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel>
            <h3 className="mb-4 font-semibold text-ink">Tests by suite</h3>
            <BarChart
              label="Tests by suite"
              max={346}
              bars={TEST_SUITES}
              note={<>471 = SDK 346 + API 87 + MCP 17 + demo 12 + NEAR AI agent 9. All pass.</>}
            />
          </Panel>
          <div className="grid gap-4">
            <Panel>
              <h3 className="mb-4 font-semibold text-ink">Prompt-injection attack demo (simulated)</h3>
              <BarChart
                label="Attacker payments signed, lower is better"
                max={3}
                bars={[
                  { name: "Naive agent", value: 3, display: "3 / 3", tone: "critical", detail: "Naive: signed 3 of 3 attacker payments" },
                  { name: "Guarded agent", value: 0, display: "0 / 3", tone: "good", detail: "Guarded: signed 0 of 3 attacker payments" },
                ]}
                note={
                  <>
                    Attacker payments signed (lower is better). The guarded agent still paid the real invoice. <Code>pnpm demo:injection</Code>
                  </>
                }
              />
            </Panel>
            <Panel>
              <h3 className="mb-4 font-semibold text-ink">Live site audit (final re-run, 2026-11-13)</h3>
              <BarChart
                label="Lighthouse scores, 0 to 100"
                max={100}
                bars={LIGHTHOUSE}
                note={
                  <>
                    Lighthouse 0–100; the light tick marks the score before the fixes. OWASP ZAP: <strong className="text-good">0 failures</strong>, 62 checks passed.
                  </>
                }
              />
            </Panel>
          </div>
        </div>
      </Step>

      {/* ------------------------------------------------------------ 6. live wallet test */}
      <Step
        n={6}
        id="hiw-wallet"
        title="Live wallet test (2026-11-13, testnet)"
        sub={
          <>
            A team tester’s owner wallet, signed in through NEAR Connect, managed the vault <Code>vault.karios.testnet</Code> for the agent <Code>kariosr.testnet</Code>. Every
            step was signed in the wallet and checked live.
          </>
        }
      >
        <ol aria-label="Wallet test steps" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {WALLET_STEPS.map((s, i) => (
            <li key={s.title} className="relative">
              {/* connector to the next step (wide screens only) */}
              {i < WALLET_STEPS.length - 1 && <span aria-hidden className="absolute left-[calc(50%+1.25rem)] right-[calc(-50%+1.25rem)] top-4 hidden h-0.5 bg-line-strong xl:block" />}
              <div className="hidden justify-center xl:flex">
                <span
                  aria-hidden
                  className={`relative z-10 grid h-8 w-8 place-items-center rounded-full border-2 text-sm font-semibold ${borderFor(s.state.tone)} bg-surface ${toneText[s.state.tone]}`}
                >
                  {i + 1}
                </span>
              </div>
              <div className="card flex h-full flex-col rounded-2xl border border-line p-4 xl:mt-3 xl:h-[calc(100%-2.75rem)]">
                <h3 className="flex items-center gap-2 font-semibold text-ink">
                  <span aria-hidden className={`grid h-6 w-6 place-items-center rounded-full border-2 text-xs font-semibold xl:hidden ${borderFor(s.state.tone)} ${toneText[s.state.tone]}`}>
                    {i + 1}
                  </span>
                  <span className="sr-only">Step {i + 1}: </span>
                  {s.title}
                </h3>
                <p className="mt-2">
                  <Pill tone={s.state.tone}>{s.state.id}</Pill>
                </p>
                <ul className="mb-3 mt-2.5 space-y-1 text-[13px] leading-relaxed text-ink-2">
                  {s.lines.map((l, k) => (
                    <li key={k}>{l}</li>
                  ))}
                </ul>
                <p className="mt-auto border-t border-line pt-2.5">
                  <Tx hash={s.tx} label={s.title} />
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/50 px-4 py-3">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
            <Icon name="lock" size={15} className="mt-0.5 text-mint" />
            <span>
              Testnet only. Owner actions show a preview of exactly what will be signed. The owner (not the agent) is the only one who can fund, freeze, unfreeze or
              withdraw.
            </span>
          </p>
          <TryIt href="#/inspect?tool=vault">Try it: Inspect → ③ Vault</TryIt>
        </div>
      </Step>

      <p className="text-xs text-muted">
        Sources: README.md, JUDGING.md, docs/AUDIT.md, docs/STATUS.md, docs/injection-demo.md, SECURITY.md, docs/manual-wallet-test-2026-11-13.md.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ flow pieces */

function borderFor(tone: Tone): string {
  return tone === "good"
    ? "border-good/45"
    : tone === "critical"
      ? "border-critical/50"
      : tone === "warning"
        ? "border-warning/45"
        : tone === "serious"
          ? "border-serious/45"
          : tone === "info"
            ? "border-info/45"
            : "border-line-strong";
}

function FlowNode({
  n,
  kind = "layer",
  title,
  sub,
  aside,
  branches,
  tryIt,
  last,
}: {
  n?: string;
  kind?: "start" | "layer" | "question";
  title: string;
  sub?: string;
  aside?: string;
  branches?: Array<{ chip: ReactNode; text: string }>;
  tryIt?: { href: string; label: string };
  last?: boolean;
}) {
  const marker =
    kind === "start" ? (
      <span className="grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-surface-2 text-ink-2">
        <Icon name="bot" size={17} />
      </span>
    ) : kind === "question" ? (
      <span className="grid h-9 w-9 rotate-45 place-items-center rounded-md border border-warning/50 bg-surface-2">
        <span className="-rotate-45 text-sm font-semibold text-warning">?</span>
      </span>
    ) : (
      <span className="grid h-9 w-9 place-items-center rounded-full border border-accent bg-accent/20 text-base font-semibold text-ink">{n}</span>
    );
  return (
    <li className="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3.5">
      {/* vertical connector */}
      {!last && <span aria-hidden className="absolute bottom-[-1rem] left-[1.075rem] top-10 w-0.5 bg-line-strong" />}
      <span aria-hidden className="relative z-10">
        {marker}
      </span>
      <div className={`grid gap-3 ${branches || aside ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" : ""} ${kind === "layer" ? "rounded-xl border border-accent/40 bg-surface-2/60 p-3.5" : "py-1"}`}>
        <div className="min-w-0">
          <h3 className={`font-semibold text-ink ${kind === "layer" ? "" : "pt-1.5"}`}>
            {kind === "layer" && <span className="sr-only">Layer {n}: </span>}
            {title}
          </h3>
          {sub && <p className="mt-0.5 text-[13px] text-ink-2">{sub}</p>}
          {tryIt && (
            <div className="mt-2.5">
              <TryIt href={tryIt.href}>{tryIt.label}</TryIt>
            </div>
          )}
        </div>
        {aside && (
          <p className="flex items-start gap-2 rounded-lg border border-line bg-page/40 px-3 py-2 text-xs leading-relaxed text-ink-2">
            <Icon name="lock" size={14} className="mt-0.5 text-mint" />
            {aside}
          </p>
        )}
        {branches && (
          <ul className="space-y-1.5">
            {branches.map((b, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line bg-page/40 px-3 py-2 text-xs text-ink-2">
                {b.chip}
                <span>{b.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function Box({ children, sub, tone, mono }: { children: ReactNode; sub?: string; tone?: Tone; mono?: boolean }) {
  return (
    <li
      className={`flex flex-1 flex-col justify-center rounded-xl border px-3 py-2.5 text-center ${
        tone ? `${borderFor(tone)} ${tone === "good" ? "bg-good/10" : tone === "critical" ? "bg-critical/10" : "bg-surface-2/60"}` : "border-line-strong bg-surface-2/60"
      }`}
    >
      <span className={`text-[13px] font-semibold text-ink ${mono ? "font-mono text-[12px]" : ""}`}>{children}</span>
      {sub && <span className={`mt-0.5 text-xs ${tone ? toneText[tone] : "text-muted"}`}>{sub}</span>}
    </li>
  );
}

function Arrow() {
  return (
    <li aria-hidden className="flex items-center justify-center text-muted">
      <Icon name="arrowRight" size={16} className="rotate-90 sm:rotate-0" />
    </li>
  );
}
