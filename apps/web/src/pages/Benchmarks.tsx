import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type BenchmarkRun } from "../api";
import { Icon } from "../components/icons";
import { Button, Card, CountUp, Empty, ErrorBox, fmtMs, fmtPct, Loading, Mono, Pill, ProgressBar, Ring, timeAgo } from "../components/ui";

export function BenchmarksPage() {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const real = useQuery({
    queryKey: ["benchmarks", "real"],
    queryFn: () => api.benchmarks("real"),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "running") ? 3000 : 30_000),
  });
  const sim = useQuery({
    queryKey: ["benchmarks", "simulated"],
    queryFn: () => api.benchmarks("simulated"),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === "running") ? 1000 : 30_000),
  });
  const run = useMutation({
    mutationFn: (kind: "real" | "simulated") => api.runBenchmark(kind, key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["benchmarks"] }),
  });

  // "#/benchmarks?run=simulated" (from the start page or the command palette) starts the simulation once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    if (q.get("run") === "simulated") {
      started.current = true;
      history.replaceState(null, "", `${window.location.pathname}#/benchmarks`);
      run.mutate("simulated");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const simRunning = run.isPending || sim.data?.items[0]?.status === "running";

  return (
    <div className="space-y-6">
      <Card title="Run a benchmark" icon="zap" actions={<span className="text-xs text-muted">simulated: open to everyone · real: API key</span>}>
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="text-sm leading-relaxed text-ink-2">
              <strong className="text-ink">Simulated faults</strong> replay 12 failure scenarios (timeouts, connection resets, malformed or oversized replies, rate
              limits, lying or lagging providers, partial executions) against local mock RPC nodes. Anyone can run them; no traffic leaves the server.
            </p>
            <Button className="mt-4" size="lg" icon="play" disabled={simRunning} onClick={() => run.mutate("simulated")}>
              {simRunning ? "Running scenarios…" : "Run simulated faults"}
            </Button>
          </div>
          <div className="rounded-xl border border-line bg-surface-2/40 p-4">
            <p className="text-sm text-ink-2">
              <strong className="text-ink">Real</strong> measures the public testnet providers and needs an API key.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-xs font-medium text-ink-2">
                API key, for the real run only (kept in this tab, sent as a Bearer token)
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  className="mt-1.5 block w-64 max-w-full rounded-lg border border-line-strong bg-page/70 px-3 py-2 text-sm text-ink focus:border-link focus:outline-none focus:ring-2 focus:ring-link/30"
                />
              </label>
              <Button disabled={!key || run.isPending} variant="ghost" onClick={() => run.mutate("real")}>
                Run real (≈75 s)
              </Button>
            </div>
          </div>
        </div>
        {run.isError && (
          <div className="mt-4">
            <ErrorBox error={run.error} />
          </div>
        )}
      </Card>

      <Card title="Fault simulations" icon="activity" actions={<Pill tone="warning">simulated — not real providers</Pill>}>
        {sim.isLoading ? <Loading /> : sim.isError ? <ErrorBox error={sim.error} /> : !sim.data?.items.length ? <Empty icon="zap">No simulation has been run yet.</Empty> : <SimRun run={sim.data.items[0]!} />}
      </Card>

      <Card title="Real-world measurements" icon="server" actions={<Pill tone="info">real providers</Pill>}>
        {real.isLoading ? <Loading /> : real.isError ? <ErrorBox error={real.error} /> : !real.data?.items.length ? <Empty icon="chart">No real benchmark has been run yet.</Empty> : <RealRun run={real.data.items[0]!} />}
      </Card>
    </div>
  );
}

function RunHeader({ run }: { run: BenchmarkRun }) {
  return (
    <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
      <Pill tone={run.status === "completed" ? "good" : run.status === "running" ? "info" : "critical"}>{run.status}</Pill>
      started {timeAgo(run.startedAt)} · <Mono>{run.id}</Mono>
    </p>
  );
}

function RealRun({ run }: { run: BenchmarkRun }) {
  const r = run.result;
  if (run.status === "running") return <><RunHeader run={run} /><Loading label="Sampling providers…" /></>;
  if (!r || r.error) return <><RunHeader run={run} /><ErrorBox error={new Error(r?.error ?? "No result")} /></>;
  return (
    <div>
      <RunHeader run={run} />
      <p className="mb-2 text-xs text-ink-2">
        {r.rounds} rounds of <Mono>{r.method}</Mono> for recent testnet tx <Mono>{r.referenceTx.hash}</Mono>.
      </p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-1 font-normal">Provider</th>
            <th className="pb-1 text-right font-normal">Samples</th>
            <th className="pb-1 text-right font-normal">Availability</th>
            <th className="pb-1 text-right font-normal">Agreement</th>
            <th className="pb-1 text-right font-normal">p50</th>
            <th className="pb-1 text-right font-normal">p95</th>
            <th className="pb-1 text-right font-normal">p99</th>
            <th className="pb-1 font-normal">Errors</th>
          </tr>
        </thead>
        <tbody>
          {(r.providers ?? []).map((p: any) => (
            <tr key={p.provider} className="border-t border-line">
              <td className="py-1.5 text-ink">{p.provider}</td>
              <td className="py-1.5 text-right tabular text-ink-2">
                {p.samples} {!p.sufficientSample && <span className="text-xs text-warning">insufficient</span>}
              </td>
              <td className="py-1.5 text-right tabular text-ink-2">{fmtPct(p.availability)}</td>
              <td className="py-1.5 text-right tabular text-ink-2">{fmtPct(p.agreementRate)}</td>
              <td className="py-1.5 text-right tabular text-ink-2">{fmtMs(p.latencyMs.p50)}</td>
              <td className="py-1.5 text-right tabular text-ink-2">{fmtMs(p.latencyMs.p95)}</td>
              <td className="py-1.5 text-right tabular text-ink-2">{fmtMs(p.latencyMs.p99)}</td>
              <td className="py-1.5 text-xs text-ink-2">{Object.keys(p.errors).length ? JSON.stringify(p.errors) : <span className="text-muted">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer text-link">Methodology</summary>
        <p className="mt-1 leading-relaxed">{r.methodology}</p>
      </details>
    </div>
  );
}

function SimRun({ run }: { run: BenchmarkRun }) {
  const r = run.result;
  if (run.status === "running")
    return (
      <>
        <RunHeader run={run} />
        <Loading label="Running fault scenarios…" />
        <ProgressBar />
      </>
    );
  if (!r || r.error) return <><RunHeader run={run} /><ErrorBox error={new Error(r?.error ?? "No result")} /></>;
  return (
    <div>
      <RunHeader run={run} />
      <div className="mb-5 flex flex-wrap items-center gap-5 rounded-xl border border-line bg-surface-2/50 p-4 animate-scale-in">
        <div className="relative grid h-[72px] w-[72px] place-items-center">
          <div className="absolute inset-0">
            <Ring value={r.total ? r.passed / r.total : 0} size={72} stroke={7} tone={r.passed === r.total ? "good" : "critical"} />
          </div>
          <Icon name={r.passed === r.total ? "check" : "alert"} size={24} className={r.passed === r.total ? "text-good" : "text-critical"} />
        </div>
        <div>
          <p className="text-2xl font-semibold tracking-tight text-ink">
            <CountUp value={r.passed} /> / {r.total} scenarios produced the expected classification.
          </p>
          <p className="mt-1 text-xs text-muted">{r.note}</p>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-1 font-normal">Scenario</th>
            <th className="pb-1 font-normal">Expected verdict</th>
            <th className="pb-1 font-normal">Observed</th>
            <th className="pb-1 font-normal">Result</th>
          </tr>
        </thead>
        <tbody>
          {r.scenarios.map((s: any) => (
            <tr key={s.name} className="border-t border-line align-top">
              <td className="py-1.5">
                <p className="text-ink">{s.name}</p>
                <p className="text-xs text-muted">{s.description}</p>
              </td>
              <td className="py-1.5 text-xs text-ink-2">
                {s.expected.verdict}
                {s.expected.errorKindA && <p className="text-muted">error {s.expected.errorKindA}</p>}
                {s.expected.diagnostic && <p className="text-muted">diagnostic {s.expected.diagnostic}</p>}
              </td>
              <td className="py-1.5 text-xs text-ink-2">
                {s.observed.verdict}
                {s.observed.errorKindA && <p className="text-muted">error {s.observed.errorKindA}</p>}
                <p className="text-muted">{s.observed.state} · {s.observed.agreement}</p>
              </td>
              <td className="py-1.5">{s.pass ? <Pill tone="good">pass</Pill> : <Pill tone="critical">fail</Pill>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
