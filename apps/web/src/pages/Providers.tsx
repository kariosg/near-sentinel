import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { LatencyChart } from "../components/LatencyChart";
import { Card, Empty, ErrorBox, fmtMs, fmtPct, Loading, Mono, Pill, Source } from "../components/ui";

/** "no" is a warning only where it limits Sentinel (method support); a non-archival node is normal. */
const yes = (v: boolean | null, noTone: "warning" | "neutral" = "warning") =>
  v === null ? <Pill tone="neutral">unknown</Pill> : v ? <Pill tone="good">yes</Pill> : <Pill tone={noTone}>no</Pill>;

export function ProvidersPage() {
  const [hours, setHours] = useState(1);
  const health = useQuery({ queryKey: ["providerHealth"], queryFn: api.providerHealth, refetchInterval: 60_000 });
  const metrics = useQuery({ queryKey: ["providerMetrics"], queryFn: api.providerMetrics, refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ["providerHistory", hours], queryFn: () => api.providerHistory(hours), refetchInterval: 30_000 });
  const config = useQuery({ queryKey: ["providers"], queryFn: api.providers });

  return (
    <div className="space-y-4">
      <Card title="Health" icon="activity" actions={health.data && <Source source={health.data.source} at={health.data.checkedAt} />}>
        {health.isLoading ? (
          <Loading label="Probing providers…" />
        ) : health.isError ? (
          <ErrorBox error={health.error} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-normal">Provider</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 text-right font-normal">Latency</th>
                  <th className="pb-2 text-right font-normal">Height lag</th>
                  <th className="pb-2 font-normal">Archival (tested)</th>
                  <th className="pb-2 font-normal">
                    <Mono>tx</Mono>
                  </th>
                  <th className="pb-2 font-normal">
                    <Mono>tx_status</Mono>
                  </th>
                  <th className="pb-2 font-normal">
                    <Mono>EXPERIMENTAL_tx_status</Mono>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(health.data?.providers ?? []).map((p) => (
                  <tr key={p.provider} className="border-t border-line align-top">
                    <td className="py-2">
                      <p className="text-ink">{p.provider}</p>
                      <p className="text-xs text-muted">
                        {p.operator} · <Mono>{p.url}</Mono>
                      </p>
                    </td>
                    <td className="py-2">
                      {p.reachable ? <Pill tone="good">up</Pill> : <Pill tone="critical" title={p.error?.message}>down · {p.error?.kind}</Pill>}
                      {p.chainId && <p className="mt-1 whitespace-nowrap text-xs text-muted">chain {p.chainId} · proto {p.protocolVersion}</p>}
                    </td>
                    <td className="whitespace-nowrap py-2 text-right tabular text-ink-2">{fmtMs(p.latencyMs)}</td>
                    <td className="py-2 text-right tabular text-ink-2">{p.heightLag ?? "—"}</td>
                    <td className="py-2">{yes(p.capabilities.archival, "neutral")}</td>
                    <td className="py-2">{yes(p.capabilities.supportsTxMethod)}</td>
                    <td className="py-2">{yes(p.capabilities.supportsTxStatusMethod)}</td>
                    <td className="py-2">{yes(p.capabilities.supportsExperimentalTxStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">
              Capabilities are <strong className="text-ink-2">tested</strong> by calling each method, not read from the provider's own <Mono>status</Mono> (which can
              misreport, e.g. archival nodes reporting a recent earliest block).
            </p>
          </div>
        )}
      </Card>

      <Card
        title="Latency history"
        icon="activity"
        actions={
          <div className="flex gap-1 text-xs" role="group" aria-label="Time range">
            {[1, 6, 24].map((h) => (
              <button key={h} type="button" onClick={() => setHours(h)} aria-pressed={hours === h} className={`rounded px-2 py-1 ${hours === h ? "bg-surface-2 text-ink" : "text-muted hover:text-ink-2"}`}>
                {h}h
              </button>
            ))}
          </div>
        }
      >
        {history.isLoading ? (
          <Loading />
        ) : history.isError ? (
          <ErrorBox error={history.error} />
        ) : (
          <>
            <LatencyChart samples={history.data!.samples} providers={config.data?.providers.map((p) => p.name) ?? []} />
            <p className="mt-2 text-xs text-muted">
              <Mono>status</Mono> round-trip from this server, sampled by the background prober. Gaps = provider unreachable.
            </p>
          </>
        )}
      </Card>

      <Card title="Request metrics" icon="chart" actions={<span className="text-xs text-muted">all RPC calls since server start</span>}>
        {metrics.isLoading ? (
          <Loading />
        ) : metrics.isError ? (
          <ErrorBox error={metrics.error} />
        ) : !metrics.data?.providers.length ? (
          <Empty>No requests yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-1 font-normal">Provider</th>
                <th className="pb-1 text-right font-normal">Requests</th>
                <th className="pb-1 text-right font-normal">Answer rate</th>
                <th className="pb-1 text-right font-normal">p50</th>
                <th className="pb-1 text-right font-normal">p95</th>
                <th className="pb-1 font-normal">Failures</th>
              </tr>
            </thead>
            <tbody>
              {metrics.data.providers.map((p) => (
                <tr key={p.provider} className="border-t border-line">
                  <td className="py-1.5 text-ink">{p.provider}</td>
                  <td className="py-1.5 text-right tabular text-ink-2">{p.requests}</td>
                  <td className="py-1.5 text-right tabular text-ink-2">
                    {fmtPct(p.answerRate)}
                    {!p.sufficientSample && <span className="ml-1 text-xs text-muted" title="Fewer than 30 requests: not enough to judge reliability">(small sample)</span>}
                  </td>
                  <td className="py-1.5 text-right tabular text-ink-2">{fmtMs(p.latencyMs.p50)}</td>
                  <td className="py-1.5 text-right tabular text-ink-2">{fmtMs(p.latencyMs.p95)}</td>
                  <td className="py-1.5 text-xs text-ink-2">
                    {Object.keys(p.failures).length ? Object.entries(p.failures).map(([k, v]) => `${k}: ${v}`).join(", ") : <span className="text-muted">none</span>}
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
