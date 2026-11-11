import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card, Empty, ErrorBox, Loading, Pill, timeAgo } from "../components/ui";

const sevTone = { critical: "critical", major: "serious", minor: "warning", info: "info" } as const;

export function IncidentsPage() {
  const q = useQuery({ queryKey: ["incidents", "all"], queryFn: () => api.incidents(false), refetchInterval: 30_000 });
  return (
    <Card title="Provider incidents" icon="alert" actions={<span className="text-xs text-muted">opened automatically after 2 consecutive bad probes; closed on recovery</span>}>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : !q.data?.items.length ? (
        <Empty>No incidents recorded. A single failed probe never opens one.</Empty>
      ) : (
        <ul className="space-y-2">
          {q.data.items.map((i) => (
            <li key={i.id} className="rounded-xl border border-line bg-surface-2/60 p-4 animate-fade-up">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={sevTone[i.severity]}>{i.severity}</Pill>
                <span className="text-sm font-medium text-ink">{i.kind}</span>
                <span className="text-sm text-ink-2">· {i.provider}</span>
                <span className="ml-auto">{i.closedAt ? <Pill tone="neutral">resolved {timeAgo(i.closedAt)}</Pill> : <Pill tone="warning">open</Pill>}</span>
              </div>
              <p className="mt-1 text-sm text-ink-2">{i.summary}</p>
              <p className="mt-1 text-xs text-muted">
                opened {new Date(i.openedAt).toLocaleString()}
                {i.closedAt && ` · closed ${new Date(i.closedAt).toLocaleString()}`}
              </p>
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-link">evidence</summary>
                <pre className="mt-1 overflow-auto rounded bg-page p-2 font-mono text-[11px] text-ink-2">{JSON.stringify(i.evidence, null, 1)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
