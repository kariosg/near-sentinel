import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Icon } from "../components/icons";
import { Card, CountUp, Empty, ErrorBox, fmtMs, linkClass, LiveDot, Mono, Pill, Ring, short, Skeleton, Source, Stat, stateTone, timeAgo, verdictTone } from "../components/ui";

export function OverviewPage() {
  const health = useQuery({ queryKey: ["providerHealth"], queryFn: api.providerHealth, refetchInterval: 60_000 });
  const incidents = useQuery({ queryKey: ["incidents", "open"], queryFn: () => api.incidents(true), refetchInterval: 60_000 });
  const reports = useQuery({ queryKey: ["reports"], queryFn: api.reports, refetchInterval: 30_000 });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });

  const rows = health.data?.providers ?? [];
  const up = health.data ? rows.filter((p) => p.reachable).length : undefined;
  const total = health.data ? rows.length : undefined;
  const operators = new Set(rows.filter((p) => p.reachable).map((p) => p.operator)).size;
  const need = providers.data?.minIndependentOperators ?? 2;
  const openCount = incidents.data?.items.length;

  return (
    <div className="space-y-6">
      {/* status hero */}
      <section aria-label="System status" className="card glow-border grid gap-6 rounded-2xl p-6 md:grid-cols-[auto_1fr_auto] md:items-center">
        <div className="relative grid h-[88px] w-[88px] place-items-center">
          <div className="absolute inset-0">
            <Ring value={up !== undefined && total ? up / total : 0} size={88} stroke={8} tone={up === total ? "good" : "warning"} />
          </div>
          <Icon name="shieldCheck" size={30} className={up === total ? "text-good" : "text-warning"} />
        </div>
        <div>
          <p className="flex items-center gap-2 text-sm text-muted">
            {up !== undefined && up > 0 && <LiveDot tone={up === total ? "good" : "warning"} />}
            {health.data ? "Live provider check" : "Checking providers…"}
          </p>
          <p className="mt-1 text-xl font-semibold tracking-tight text-ink">
            {health.data
              ? operators >= need
                ? `Ready: ${operators} independent operators reachable, ${need} needed for SAFE_TO_RETRY`
                : `Degraded: ${operators} independent operator${operators === 1 ? "" : "s"} reachable, ${need} needed — Sentinel will not say SAFE_TO_RETRY`
              : "…"}
          </p>
          <p className="mt-1.5 text-sm text-ink-2">
            When a NEAR transaction times out, the dangerous move is to sign a <em>new</em> one: if the first already landed, the funds move twice. Sentinel asks
            several independent RPC providers and answers with evidence. It is read-only.
          </p>
        </div>
        <a href="#/inspect" className="inline-flex items-center gap-2 self-start rounded-xl bg-gradient-to-b from-accent to-accent-2 px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 md:self-center">
          <Icon name="search" size={16} />
          Check a transaction
        </a>
      </section>

      {health.isError ? (
        <ErrorBox error={health.error} />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon="layers" label="Network" value={providers.data?.network ?? "…"} hint={`SAFE_TO_RETRY needs ${providers.data?.minIndependentOperators ?? "…"} independent operators`} />
          <Stat
            icon="server"
            tone={up !== undefined && up === total ? "good" : "warning"}
            label="Providers reachable"
            value={up === undefined ? "…" : <><CountUp value={up} /> / {total}</>}
            hint={health.data && <Source source="background prober" at={health.data.checkedAt} />}
          />
          <Stat icon="shield" label="Independent operators up" value={health.data ? <CountUp value={operators} /> : "…"} hint="Same company behind two URLs counts once" />
          <Stat
            icon="alert"
            tone={openCount ? "warning" : "good"}
            label="Open incidents"
            value={openCount === undefined ? "…" : <CountUp value={openCount} />}
            hint={openCount ? <a className={linkClass} href="#/incidents">view</a> : "none open"}
          />
        </div>
      )}

      {/* provider tiles */}
      <Card title="Providers right now" subtitle="One tile per RPC endpoint Sentinel cross-checks" icon="activity" actions={<a href="#/providers" className={`text-xs ${linkClass}`}>details</a>}>
        {!health.data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[72px] w-full" />
            ))}
          </div>
        ) : (
          <ul className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map((p) => (
              <li key={p.provider} className={`rounded-xl border bg-surface-2/50 p-3.5 ${p.reachable ? "border-line" : "border-critical/40"}`}>
                <p className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">{p.provider}</span>
                  {p.reachable ? <Pill tone="good">up</Pill> : <Pill tone="critical">down</Pill>}
                </p>
                <p className="mt-1.5 flex items-center justify-between text-xs text-muted">
                  <span>{p.operator}</span>
                  <span className="tabular text-ink-2">{fmtMs(p.latencyMs)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent inspections" subtitle="Saved reports, kept 30 days" icon="file">
        {reports.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        ) : reports.isError ? (
          <ErrorBox error={reports.error} />
        ) : !reports.data?.items.length ? (
          <Empty icon="search">
            No inspections yet.{" "}
            <a className={linkClass} href="#/inspect?example=partial">
              Inspect a real transaction
            </a>
            .
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Transaction</th>
                <th className="pb-2 font-medium">State</th>
                <th className="pb-2 font-medium">Verdict</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {reports.data.items.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-2.5 text-xs text-muted">{timeAgo(r.createdAt)}</td>
                  <td className="py-2.5">
                    <Mono className="text-ink-2">{short(r.txHash)}</Mono>
                  </td>
                  <td className="py-2.5">
                    <Pill tone={stateTone(r.state)}>{r.state}</Pill>
                  </td>
                  <td className="py-2.5">
                    <Pill tone={verdictTone(r.verdict)}>{r.verdict}</Pill>
                  </td>
                  <td className="py-2.5 text-right">
                    <a className={`text-xs ${linkClass}`} href={`/api/v1/reports/${r.id}`} target="_blank" rel="noreferrer">
                      report ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
