import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Card, ErrorBox, Loading, Mono, Pill } from "../components/ui";

export function SettingsPage() {
  const cfg = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  return (
    <div className="space-y-4">
      <Card title="Configuration (read-only)" icon="settings">
        {cfg.isLoading ? (
          <Loading />
        ) : cfg.isError ? (
          <ErrorBox error={cfg.error} />
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Network</dt>
            <dd className="text-ink">{cfg.data!.network}</dd>
            <dt className="text-muted">Independent operators for SAFE_TO_RETRY</dt>
            <dd className="text-ink">{cfg.data!.minIndependentOperators}</dd>
            <dt className="text-muted">API / SDK version</dt>
            <dd className="text-ink">
              {health.data?.version} / {health.data?.sdk}
            </dd>
          </dl>
        )}
        <p className="mt-3 text-xs text-muted">
          Settings are environment variables on the server (see <Mono>.env.example</Mono>). The dashboard cannot change them.
        </p>
      </Card>
      <Card title="Providers" icon="server">
        {cfg.data && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-1 font-normal">Name</th>
                <th className="pb-1 font-normal">Operator</th>
                <th className="pb-1 font-normal">URL</th>
                <th className="pb-1 font-normal">Origin</th>
              </tr>
            </thead>
            <tbody>
              {cfg.data.providers.map((p) => (
                <tr key={p.name} className="border-t border-line">
                  <td className="py-1.5 text-ink">{p.name}</td>
                  <td className="py-1.5 text-ink-2">{p.operator}</td>
                  <td className="py-1.5">
                    <Mono className="text-ink-2">{p.url}</Mono>
                  </td>
                  <td className="py-1.5">{p.custom ? <Pill tone="info">custom</Pill> : <Pill tone="neutral">configured</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-muted">
          Custom providers are added with <Mono>POST /api/v1/providers</Mono> (API key required, SSRF-guarded, chain id verified).
        </p>
      </Card>
      <Card title="Security model" icon="lock">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
          <li>Read-only: Sentinel never signs, submits or holds keys. It only reads public chain data.</li>
          <li>Unknown is never reported as safe. SAFE_TO_RETRY requires proof from independent operators.</li>
          <li>Provider answers are validated (right tx hash, well-formed) before they count as evidence.</li>
        </ul>
      </Card>
    </div>
  );
}
