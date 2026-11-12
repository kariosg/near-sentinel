import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type DemoRun } from "../api";
import { Icon, type IconName } from "../components/icons";
import { GLOSSARY, Term } from "../components/Term";
import { CodeBlock, CountUp, LiveDot, Pill, toneText, VERDICTS, verdictTone } from "../components/ui";
import { VerdictTree } from "../components/VerdictTree";
import { DEMO_ACCOUNTS, DEMO_TXS, explorerAccount } from "../demoData";

const TOUR_KEY = "sentinel.tour";

type Step = { id: string; title: string; href: string; time: string; icon: IconName; what: string; expect: string; cta: string };
const STEPS: Step[] = [
  {
    id: "proof",
    title: "Check the real-money proof yourself",
    href: "#/inspect?example=guarded",
    time: "20 s",
    icon: "coins",
    what: "The real testnet payment from the demo: the reply timed out, the guarded agent asked Sentinel instead of paying again.",
    expect: "DO_NOT_RETRY: the payment landed, confirmed by independent providers. The naive agent's two payments are one click away on the same page.",
    cta: "Check it",
  },
  {
    id: "inspect",
    title: "Inspect a real testnet transaction",
    href: "#/inspect?example=partial",
    time: "30 s",
    icon: "search",
    what: "A real transaction whose top-level status says success, while two downstream contract calls failed.",
    expect: "Verdict MANUAL_REVIEW_REQUIRED, per-provider evidence, and the failed ft_burn highlighted in the receipt graph.",
    cta: "Run it",
  },
  {
    id: "bench",
    title: "Run the 12 fault-injection scenarios",
    href: "#/benchmarks?run=simulated",
    time: "10 s",
    icon: "zap",
    what: "Timeouts, resets, malformed and oversized replies, rate limits, lying or lagging providers, partial executions.",
    expect: "12 / 12 scenarios classified correctly. Runs on local mock nodes, no key needed.",
    cta: "Start",
  },
  {
    id: "providers",
    title: "See live provider health",
    href: "#/providers",
    time: "20 s",
    icon: "server",
    what: "Four public testnet RPC endpoints, each capability tested by calling it, not by trusting its own status.",
    expect: "dRPC marked without tx_status support; only the archival node marked archival.",
    cta: "Open",
  },
  {
    id: "guard",
    title: "Look up the Guard contract",
    href: "#/inspect",
    time: "20 s",
    icon: "shieldCheck",
    what: "Sentinel Guard is a Rust contract, live on testnet as guard.karios.testnet: pay(intent_id, receiver_id) pays at most once per payer and intent.",
    expect: "In the Guard panel on the Inspect page, click Paid intent: PAID, confirmed by every provider. Unused intent: NOT_RECORDED.",
    cta: "Open",
  },
  {
    id: "security",
    title: "Check an agent's keys and a payment before signing",
    href: "#/inspect?tool=keys",
    time: "30 s",
    icon: "lock",
    what: "Agent security: the key check flags keys that could drain an agent's account, and the Vault's payment check runs the contract's own rules before anything is signed.",
    expect: "FULL_ACCESS_PRESENT for the demo agent, with the commands for a safe spend-only key. In the Vault panel above it, a payment to an unlisted receiver is BLOCKED.",
    cta: "Check it",
  },
  {
    id: "mcp",
    title: "Connect an AI agent (MCP)",
    href: "#/integrate",
    time: "1 min",
    icon: "bot",
    what: "Nine read-only MCP tools, including check_retry_safety, check_intent, check_spend_allowance, preflight_spend and audit_agent_keys.",
    expect: "A copy-paste command for Claude Code or any MCP client.",
    cta: "Open",
  },
];

function useTour(): [Set<string>, (id: string) => void, () => void] {
  const read = () => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(TOUR_KEY) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  };
  const [done, setDone] = useState(read);
  const mark = (id: string) => {
    const n = new Set(done).add(id);
    localStorage.setItem(TOUR_KEY, JSON.stringify([...n]));
    setDone(n);
  };
  const reset = () => {
    localStorage.removeItem(TOUR_KEY);
    setDone(new Set());
  };
  return [done, mark, reset];
}

export function StartPage() {
  const health = useQuery({ queryKey: ["providerHealth"], queryFn: api.providerHealth, refetchInterval: 60_000 });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const [done, mark, reset] = useTour();
  const rows = health.data?.providers ?? [];
  const up = rows.filter((p) => p.reachable).length;
  const scrollToTour = () => document.getElementById("tour")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-16">
      {/* ------------------------------------------------------------ hero */}
      <section aria-labelledby="hero-title" className="grid items-center gap-10 pt-2 lg:grid-cols-[1.05fr_1fr]">
        <div className="stagger">
          <div className="flex flex-wrap gap-2">
            <Pill tone="info">NEAR HACKATHON</Pill>
            <Pill tone="neutral">AI Security &amp; Defense</Pill>
            <Pill tone="neutral">Agent Economy</Pill>
          </div>
          <h1 id="hero-title" className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            <span className="text-ink">The RPC timed out.</span>
            <br />
            <span className="text-gradient">Did the payment land?</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-2">
            Sign again and an AI agent may pay twice; don&apos;t, and it may never pay. NEAR Sentinel answers with proof from independent RPC providers before the
            agent signs anything new: <strong>landed</strong>, <strong>can still land</strong>, <strong>can never land</strong> (proven by its <Term k="nonce">nonce</Term> or{" "}
            <Term k="validity">validity window</Term>), or <strong>partly executed</strong>. It works on any NEAR transaction, guarded or not, with no contract to adopt.
          </p>
          <div className="mt-5 max-w-xl rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm" aria-label="Proof on testnet with real money">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Proven on testnet with real money</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
              <span>
                Naive agent paid <strong className="text-critical">twice</strong>
              </span>
              <a className="font-mono text-xs text-link underline" href="https://testnet.nearblocks.io/txns/185YtdJZxUCMAaqjRtmSj4MTx51mdiMpjhAPmZ3rZaH" target="_blank" rel="noreferrer">
                tx 1
              </a>
              <a className="font-mono text-xs text-link underline" href="https://testnet.nearblocks.io/txns/6h2hMxjpjdYwDF6zXJ5gTwD5MY47UT7thdRaxZM2Pc6h" target="_blank" rel="noreferrer">
                tx 2
              </a>
              <span className="text-muted">·</span>
              <span>
                Sentinel-guarded agent paid <strong className="text-good">once</strong>
              </span>
              <a className="font-mono text-xs text-link underline" href="https://testnet.nearblocks.io/txns/C59gttNUHCaVTHVi2GKCw6zu5C7QcmwPbUuw9NeaXnzS" target="_blank" rel="noreferrer">
                tx
              </a>
              <a className="text-xs font-medium text-link underline" href="#/inspect?example=guarded" onClick={() => mark("proof")}>
                Check it in Sentinel →
              </a>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-2">
              <span>
                Unsent payment: <strong className="text-warning">WAIT</strong>, then proven <strong className="text-good">SAFE to pay again</strong> once its nonce
                was{" "}
                <span className="whitespace-nowrap">
                  used{" "}
                  <a className="font-mono text-xs text-link underline" href="https://testnet.nearblocks.io/txns/6jM2toRMAb9KDNTSNHrCVSGEY5ttJenXnAiirBPE7wnj" target="_blank" rel="noreferrer">
                    tx
                  </a>
                </span>
              </span>
            </p>
          </div>
          <div className="mt-7 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={scrollToTour}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-accent to-accent-2 px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_32px_-12px_rgb(37_99_235/0.9)] transition hover:brightness-110 active:scale-[0.98]"
            >
              <Icon name="rocket" size={17} />
              Start the 3-minute tour
            </button>
            <a
              href="#/inspect?example=partial"
              onClick={() => mark("inspect")}
              className="inline-flex items-center gap-2 rounded-xl border border-line-strong px-5 py-3 text-sm font-semibold text-ink transition hover:border-link/60 hover:bg-surface-2"
            >
              <Icon name="play" size={15} />
              Try a real transaction
            </a>
          </div>
          <dl className="mt-8 grid max-w-lg grid-cols-3 gap-4 border-t border-line pt-5">
            <div>
              <dt className="text-xs text-muted">RPC providers live</dt>
              <dd className="mt-1 flex items-center gap-2 text-xl font-semibold text-ink">
                {health.data ? (
                  <>
                    {up > 0 && <LiveDot />}
                    <CountUp value={up} /> / {rows.length}
                  </>
                ) : (
                  "…"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                <Term k="operators">Operators</Term> for “safe”
              </dt>
              <dd className="mt-1 text-xl font-semibold text-ink">≥ {providers.data?.minIndependentOperators ?? 2}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Network</dt>
              <dd className="mt-1 text-xl font-semibold text-ink">{providers.data?.network ?? "testnet"}</dd>
            </div>
          </dl>
        </div>
        {/* On phones the diagram would shrink below readable size; the hero text already says the same. */}
        <div className="hidden sm:block">
          <FlowDiagram providers={rows.length ? rows.map((r) => ({ name: r.provider, up: r.reachable })) : undefined} />
        </div>
      </section>

      {/* ------------------------------------------------------------ problem / solution */}
      <section aria-labelledby="why-title">
        <SectionTitle id="why-title" eyebrow="The problem" title="A timeout is not a failure" sub="The same agent, the same timeout, in the same simulated chain (from pnpm demo)." />
        <div className="grid gap-5 md:grid-cols-2">
          <Story
            tone="critical"
            title="Naive agent"
            result={2}
            steps={["Signs and sends 1 NEAR", "RPC times out after 1.5 s (the transfer did land)", "“It failed”: signs a NEW transaction", "Merchant receives 2 NEAR"]}
          />
          <Story
            tone="good"
            title="Agent guarded by Sentinel"
            result={1}
            steps={["Signs and sends 1 NEAR", "RPC times out after 1.5 s", "Asks Sentinel → DO_NOT_RETRY (executed, 2 providers agree)", "Merchant receives 1 NEAR"]}
          />
        </div>
        <LiveDemo />
      </section>

      {/* ------------------------------------------------------------ tour */}
      <section id="tour" aria-labelledby="tour-title" className="scroll-mt-24">
        <SectionTitle id="tour-title" eyebrow="For judges" title="The 3-minute tour" sub="Each step is one click and works without a wallet. Your progress is saved in this browser." />
        <div className="mb-4 flex items-center gap-4">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div className="h-full rounded-full bg-gradient-to-r from-accent to-mint transition-all duration-700" style={{ width: `${(done.size / STEPS.length) * 100}%` }} />
          </div>
          <p className="text-sm text-ink-2">
            <span className="font-semibold text-ink">{STEPS.filter((s) => done.has(s.id)).length}</span> of {STEPS.length} done
          </p>
          {done.size > 0 && (
            <button type="button" onClick={reset} className="text-xs text-link underline underline-offset-2 hover:no-underline">
              Reset
            </button>
          )}
        </div>
        <ol className="stagger grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {STEPS.map((s, i) => {
            const ok = done.has(s.id);
            return (
              <li key={s.id} className={`card card-hover flex flex-col rounded-2xl border p-5 ${ok ? "border-good/40" : "border-line"}`}>
                <div className="flex items-start justify-between gap-3">
                  <span className={`grid h-10 w-10 place-items-center rounded-xl ${ok ? "bg-good/15 text-good" : "bg-surface-2 text-link"}`}>
                    <Icon name={ok ? "check" : s.icon} size={19} />
                  </span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                    Step {i + 1} · {s.time}
                  </span>
                </div>
                <h3 className="mt-4 font-semibold text-ink">{s.title}</h3>
                <p className="mt-1.5 text-sm text-ink-2">{s.what}</p>
                <p className="mt-3 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-xs leading-relaxed text-ink-2">
                  <span className="font-semibold text-mint">You should see: </span>
                  {s.expect}
                </p>
                <a
                  href={s.href}
                  aria-label={`${s.cta}: ${s.title}`}
                  onClick={() => mark(s.id)}
                  className="mt-4 inline-flex items-center gap-1.5 self-start rounded-lg bg-surface-3 px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-accent hover:text-white"
                >
                  {s.cta}
                  <Icon name="arrowRight" size={15} />
                </a>
              </li>
            );
          })}
          <li className="card flex flex-col justify-center rounded-2xl border border-dashed border-line-strong p-5 text-sm text-ink-2">
            <p className="flex items-center gap-2 font-semibold text-ink">
              <Icon name="command" size={17} className="text-link" /> Shortcut
            </p>
            <p className="mt-2">
              Press <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 font-mono text-[11px]">Ctrl K</kbd> anywhere to jump to a page or run an
              example.
            </p>
          </li>
        </ol>
      </section>

      {/* ------------------------------------------------------------ verdicts */}
      <section aria-labelledby="verdicts-title">
        <SectionTitle id="verdicts-title" eyebrow="The answer" title="Four verdicts, never a guess" sub="“Unknown” is never reported as safe. SAFE_TO_RETRY needs proof from a quorum of independent operators." />
        <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {VERDICTS.map((v) => {
            const tone = verdictTone(v.id);
            return (
              <div key={v.id} className="card card-hover rounded-2xl border border-line p-5">
                <span className={`grid h-10 w-10 place-items-center rounded-xl bg-surface-2 ${toneText[tone]}`}>
                  <Icon name={v.icon} size={19} />
                </span>
                <p className={`mt-4 font-mono text-[11px] font-semibold ${toneText[tone]}`}>{v.id}</p>
                <h3 className="mt-1 font-semibold text-ink">{v.title}</h3>
                <p className="mt-2 text-sm text-ink-2">{v.meaning}</p>
                <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                  <span className="font-semibold text-ink-2">Agent: </span>
                  {v.agent}
                </p>
              </div>
            );
          })}
        </div>
        <VerdictTree />
      </section>

      {/* ------------------------------------------------------------ demo data + glossary */}
      <section aria-labelledby="demo-data-title">
        <SectionTitle
          id="demo-data-title"
          eyebrow="Test it yourself"
          title="Real demo data, no wallet needed"
          sub="Every transaction and account below is real on NEAR testnet. Click one to check it in Sentinel, or open it in the explorer."
        />
        <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <div className="card rounded-2xl border border-line p-5">
            <h3 className="font-semibold text-ink">Transactions to try</h3>
            <ul className="mt-3 divide-y divide-line">
              {DEMO_TXS.map((x) => (
                <li key={x.key} className="py-2.5 text-sm">
                  <a className="font-medium text-link underline underline-offset-2" href={`#/inspect?example=${x.key}`} onClick={() => x.key === "guarded" && mark("proof")}>
                    {x.label}
                  </a>
                  <span className="mt-0.5 block text-xs text-ink-2">
                    You&apos;ll see: <span className="font-medium text-ink">{x.expect}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-5">
            <div className="card rounded-2xl border border-line p-5">
              <h3 className="font-semibold text-ink">Demo accounts</h3>
              <ul className="mt-3 space-y-2.5 text-sm">
                {DEMO_ACCOUNTS.map((a) => (
                  <li key={a.id}>
                    <a className="font-mono text-xs text-link underline" href={explorerAccount(a.id)} target="_blank" rel="noreferrer">
                      {a.id}
                    </a>
                    <p className="text-xs text-ink-2">{a.role}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card rounded-2xl border border-line p-5">
              <h3 id="glossary" className="font-semibold text-ink">
                Glossary
              </h3>
              <dl className="mt-3 space-y-2.5 text-sm">
                {Object.values(GLOSSARY).map((g) => (
                  <div key={g.term}>
                    <dt className="font-medium text-ink">{g.term}</dt>
                    <dd className="text-xs leading-relaxed text-ink-2">{g.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ terminal */}
      <section aria-labelledby="verify-title" className="grid gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-center">
        <div>
          <SectionTitle id="verify-title" eyebrow="Reproduce it" title="Verify from your terminal" sub="Node ≥ 22.16 and pnpm 8. Docker only for the contract suite." />
          <ul className="space-y-3 text-sm text-ink-2">
            {[
              ["310 unit and integration tests", "SDK, MCP server (real stdio), API, demo, NEAR AI agent"],
              ["10 live tests", "read-only, against public testnet and mainnet RPCs"],
              ["51 browser tests", "flows, accessibility, phone/tablet/desktop, keyboard, this tour, the demo data, agent security"],
              ["33 + 27 + 21 contract checks", "Guard and Vault: Rust unit tests, a local NEAR node, then live on testnet"],
            ].map(([a, b]) => (
              <li key={a} className="flex gap-3">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-good/15 text-good">
                  <Icon name="check" size={12} />
                </span>
                <span>
                  <span className="font-medium text-ink">{a}</span> — {b}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <CodeBlock title="bash">{`pnpm install && pnpm build
pnpm test            # secrets check + 310 tests
pnpm demo            # naive agent pays 2 NEAR, guarded pays 1
pnpm start           # this dashboard on http://127.0.0.1:8080
pnpm test:contract   # Docker: 33 Rust tests + 27 on-chain checks`}</CodeBlock>
      </section>

      {/* ------------------------------------------------------------ inside */}
      <section aria-labelledby="inside-title">
        <SectionTitle id="inside-title" eyebrow="What ships" title="One safety layer, six ways to use it" />
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ["bot", "MCP server", "Nine read-only tools for AI agents: check_retry_safety, inspect_transaction, trace_receipts, diagnose_submission_error, provider_health, check_intent, check_spend_allowance, preflight_spend, audit_agent_keys.", "#/integrate"],
              ["layers", "TypeScript SDK", "checkRetrySafety, inspectTransaction, checkIntent, checkSpendAllowance, preflightSpend, auditAgentKeys and more. Validates every RPC answer.", "#/integrate"],
              ["terminal", "REST API", "Fastify API with OpenAPI docs, rate limits, live updates over SSE.", "/docs"],
              ["shieldCheck", "Sentinel Guard contract", "Rust, no owner, no admin, live on testnet. A repeated intent is rejected on-chain and refunded.", "#/integrate"],
              ["wallet", "Sentinel Vault contract", "Give an agent money, not keys: per-payment and daily limits, receiver allowlist, freeze. The agent spends with a function-call key. Live on testnet.", "#/integrate"],
              ["activity", "This dashboard", "Provider health, incidents, benchmarks, receipt graphs. Works on phones.", "#/overview"],
              ["shieldCheck", "Agent security & privacy", "Key check (no full-access keys on agents), payment check before signing, safety score for limits, private payment ids. Mapped to the OWASP agentic top 10.", "#/inspect?tool=keys"],
              ["lock", "Safe by design", "Never signs, never holds keys. Testnet by default. No cookies or tracking; IPs only hashed, kept 30 days.", "#/settings"],
            ] as Array<[IconName, string, string, string]>
          ).map(([icon, title, text, href]) => (
            <a key={title} href={href} target={href.startsWith("/") ? "_blank" : undefined} rel="noreferrer" className="card card-hover group rounded-2xl border border-line p-5">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent/25 to-mint/15 text-mint">
                <Icon name={icon} size={19} />
              </span>
              <h3 className="mt-4 flex items-center gap-1.5 font-semibold text-ink">
                {title}
                <Icon name="arrowRight" size={14} className="text-muted opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
              </h3>
              <p className="mt-1.5 text-sm text-ink-2">{text}</p>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ id, eyebrow, title, sub }: { id: string; eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-mint">{eyebrow}</p>
      <h2 id={id} className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">
        {title}
      </h2>
      {sub && <p className="mt-1.5 max-w-2xl text-sm text-ink-2">{sub}</p>}
    </div>
  );
}

function Story({ tone, title, steps, result }: { tone: "good" | "critical"; title: string; steps: string[]; result: number }) {
  return (
    <div className={`card rounded-2xl border p-6 ${tone === "good" ? "border-good/30" : "border-critical/30"}`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold text-ink">
          <Icon name={tone === "good" ? "shieldCheck" : "alert"} size={18} className={toneText[tone]} />
          {title}
        </h3>
        <p className={`text-right ${toneText[tone]}`}>
          <span className="text-3xl font-semibold tracking-tight">
            <CountUp value={result} /> NEAR
          </span>
          <span className="block text-xs text-muted">paid for a 1 NEAR order</span>
        </p>
      </div>
      <ol className="stagger mt-5 space-y-3">
        {steps.map((s, i) => (
          <li key={s} className="flex items-start gap-3 text-sm text-ink-2">
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
                i === steps.length - 1 ? (tone === "good" ? "border-good/50 bg-good/15 text-good" : "border-critical/50 bg-critical/15 text-critical") : "border-line-strong text-ink-2"
              }`}
            >
              {i + 1}
            </span>
            <span className={i === steps.length - 1 ? "font-medium text-ink" : ""}>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Animated architecture: agent → Sentinel → independent RPC providers → NEAR; plus the on-chain guard. */
function FlowDiagram({ providers }: { providers?: Array<{ name: string; up: boolean }> }) {
  const [motion, setMotion] = useState(false);
  useEffect(() => setMotion(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches), []);
  const list = (providers ?? [
    { name: "fastnear", up: true },
    { name: "fastnear-archival", up: true },
    { name: "drpc", up: true },
    { name: "intear", up: true },
  ]).slice(0, 4);
  const ys = [52, 112, 172, 232];
  return (
    <div className="glow-border card relative rounded-3xl p-4 sm:p-6 animate-scale-in">
      <svg
        viewBox="0 0 520 330"
        className="h-auto w-full"
        role="img"
        aria-label={`Diagram: an AI agent asks NEAR Sentinel before retrying; Sentinel cross-checks ${list.length} independent RPC providers that read the NEAR chain; payments can go through the Sentinel Guard contract, which pays at most once per intent.`}
      >
        <defs>
          <linearGradient id="fd-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2563eb" />
            <stop offset="1" stopColor="#34e0a1" />
          </linearGradient>
          <filter id="fd-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
        </defs>

        {/* links */}
        <g fill="none" strokeWidth="1.6">
          <path id="fd-a" d="M118 142 C150 142 160 142 196 142" stroke="#3a4a63" strokeDasharray="5 7" className={motion ? "animate-dash" : ""} />
          {ys.map((y, i) => (
            <path key={y} id={`fd-p${i}`} d={`M324 142 C360 142 360 ${y} 392 ${y}`} stroke={list[i]?.up === false ? "#f47272" : "#3a4a63"} strokeDasharray="5 7" className={motion ? "animate-dash" : ""} />
          ))}
          <path d="M260 182 L260 262" stroke="#3a4a63" strokeDasharray="5 7" className={motion ? "animate-dash" : ""} />
        </g>

        {/* agent */}
        <g>
          <rect x="16" y="112" width="102" height="60" rx="14" fill="#151a23" stroke="#2f3a4b" />
          <text x="67" y="138" textAnchor="middle" fill="#eef1f6" fontSize="13" fontWeight="600">AI agent</text>
          <text x="67" y="156" textAnchor="middle" fill="#8f99aa" fontSize="10.5">timed out — retry?</text>
        </g>

        {/* sentinel */}
        <g>
          <rect x="200" y="104" width="120" height="76" rx="18" fill="url(#fd-g)" opacity="0.35" filter="url(#fd-glow)" />
          <rect x="196" y="102" width="128" height="80" rx="18" fill="#0e1219" stroke="url(#fd-g)" strokeWidth="1.8" />
          <text x="260" y="134" textAnchor="middle" fill="#eef1f6" fontSize="14" fontWeight="700">NEAR Sentinel</text>
          <text x="260" y="152" textAnchor="middle" fill="#34e0a1" fontSize="10.5" fontWeight="600">DO_NOT_RETRY</text>
          <text x="260" y="168" textAnchor="middle" fill="#8f99aa" fontSize="9.5">+ evidence</text>
        </g>

        {/* providers */}
        {list.map((p, i) => (
          <g key={p.name}>
            <rect x="392" y={(ys[i] ?? 0) - 20} width="116" height="40" rx="11" fill="#151a23" stroke={p.up ? "#2f3a4b" : "#f47272"} />
            <circle cx="408" cy={ys[i]} r="4" fill={p.up ? "#2fbf5b" : "#f47272"}>
              {motion && p.up && <animate attributeName="opacity" values="1;0.35;1" dur="2s" begin={`${i * 0.4}s`} repeatCount="indefinite" />}
            </circle>
            <text x="420" y={(ys[i] ?? 0) + 4} fill="#c3cad6" fontSize="11">
              {p.name.length > 15 ? `${p.name.slice(0, 14)}…` : p.name}
            </text>
          </g>
        ))}
        <text x="450" y="276" textAnchor="middle" fill="#8f99aa" fontSize="10">independent RPC providers</text>

        {/* guard */}
        <g>
          <rect x="186" y="262" width="148" height="52" rx="14" fill="#151a23" stroke="#2f3a4b" />
          <text x="260" y="284" textAnchor="middle" fill="#eef1f6" fontSize="12" fontWeight="600">Sentinel Guard</text>
          <text x="260" y="301" textAnchor="middle" fill="#8f99aa" fontSize="10">on-chain: pay once per intent</text>
        </g>

        {/* moving packets */}
        {motion && (
          <g>
            <circle r="4" fill="#5aa2f0">
              <animateMotion dur="2.4s" repeatCount="indefinite">
                <mpath href="#fd-a" />
              </animateMotion>
            </circle>
            {list.map((_, i) => (
              <circle key={i} r="3.5" fill="#34e0a1">
                <animateMotion dur="2.4s" begin={`${0.3 + i * 0.25}s`} repeatCount="indefinite">
                  <mpath href={`#fd-p${i}`} />
                </animateMotion>
              </circle>
            ))}
          </g>
        )}
      </svg>
      <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted">
        <Icon name="lock" size={13} className="text-mint" /> Read-only: Sentinel never signs, submits or holds keys.
      </p>
    </div>
  );
}

/** Runs the naive-vs-guarded demo on the server's local simulated chain: both failure modes, both agents, with the guarded agent's verdict path. */
function LiveDemo() {
  const m = useMutation({ mutationFn: api.demoRun });
  const runs = m.data?.runs ?? [];
  const scenarios = [
    { key: "WAS delivered", title: "The payment landed, but the reply was lost", lesson: "A duplicate-blocking contract would also stop the 2nd payment here." },
    { key: "dropped", title: "The payment was lost before it landed", lesson: "Only an answer about the original can keep this safe: re-send the same bytes, never sign new ones." },
  ];
  const card = (r: DemoRun["runs"][number]) => (
    <div key={r.agent} className="rounded-xl border border-line bg-surface-2/60 p-4">
      <p className="text-sm font-semibold text-ink">{r.agent === "naive" ? "Naive agent" : "Agent guarded by Sentinel"}</p>
      <p className={`mt-1 text-xl font-semibold ${r.transfers > 1 ? "text-critical" : "text-good"}`}>
        {r.transfers} {r.transfers === 1 ? "transfer" : "transfers"} · merchant got {r.receivedNear} NEAR
      </p>
      <p className="mt-1 text-xs text-ink-2">
        {r.agent === "guarded" ? `Sentinel: ${r.decisions.join(" → ")}` : r.decisions.join(" → ")} · signed {r.signedTransactions}{" "}
        {r.signedTransactions === 1 ? "transaction" : "transactions"}
      </p>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">What the agent did</summary>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-2">{r.log.join("\n")}</pre>
      </details>
    </div>
  );
  return (
    <div className="mt-5 rounded-2xl border border-line bg-surface/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-2">
          Don&apos;t take the cards above on trust: run the same agents now, in both failure modes. The server uses a local simulated chain and a fault-injection
          proxy. No real network, no funds, no wallet.
        </p>
        <button
          type="button"
          onClick={() => m.mutate()}
          disabled={m.isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-accent to-accent-2 px-5 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
        >
          <Icon name="play" size={15} />
          {m.isPending ? "Running both agents…" : "Run it live (about 15 s)"}
        </button>
      </div>
      {m.isError && <p className="mt-3 text-sm text-warning">The demo could not run right now ({String((m.error as Error)?.message ?? m.error)}). Try again in a minute.</p>}
      {runs.length > 0 && (
        <div className="mt-4 space-y-5 animate-fade-up" aria-live="polite">
          {scenarios.map((sc) => {
            const rows = runs.filter((r) => r.scenario.includes(sc.key));
            return rows.length ? (
              <div key={sc.key}>
                <p className="text-sm font-semibold text-ink">{sc.title}</p>
                <p className="mb-2 text-xs text-muted">{sc.lesson}</p>
                <div className="grid gap-4 md:grid-cols-2">{rows.map(card)}</div>
              </div>
            ) : null;
          })}
          <p className="text-xs text-muted">Ran in {(m.data!.durationMs / 1000).toFixed(1)} s. {m.data!.note}</p>
        </div>
      )}
    </div>
  );
}
