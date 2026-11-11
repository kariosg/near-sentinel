/**
 * Prometheus text exposition on a SEPARATE listener bound to METRICS_HOST (127.0.0.1 by default),
 * so internal metrics are never exposed on the public API port.
 */
import { createServer, type Server } from "node:http";
import type { Runtime } from "./runtime.js";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderMetrics(rt: Runtime): string {
  const out: string[] = [];
  const m = rt.metrics.snapshot();
  out.push("# HELP sentinel_rpc_requests_total RPC requests sent per provider and outcome");
  out.push("# TYPE sentinel_rpc_requests_total counter");
  for (const p of m) {
    const l = `provider="${esc(p.provider)}",operator="${esc(p.operator)}"`;
    out.push(`sentinel_rpc_requests_total{${l},outcome="ok"} ${p.ok}`);
    out.push(`sentinel_rpc_requests_total{${l},outcome="rpc_error"} ${p.rpcErrors}`);
    for (const [k, v] of Object.entries(p.failures)) out.push(`sentinel_rpc_requests_total{${l},outcome="${esc(k.toLowerCase())}"} ${v}`);
  }
  out.push("# HELP sentinel_rpc_latency_ms Rolling RPC latency percentiles (answered requests)");
  out.push("# TYPE sentinel_rpc_latency_ms gauge");
  for (const p of m) {
    for (const q of ["p50", "p95", "p99"] as const) {
      const v = p.latencyMs[q];
      if (v !== null) out.push(`sentinel_rpc_latency_ms{provider="${esc(p.provider)}",quantile="${q}"} ${v}`);
    }
  }
  const h = rt.lastHealth;
  if (h) {
    out.push("# HELP sentinel_provider_up 1 if the provider answered the last health probe");
    out.push("# TYPE sentinel_provider_up gauge");
    for (const p of h.providers) out.push(`sentinel_provider_up{provider="${esc(p.provider)}"} ${p.reachable ? 1 : 0}`);
    out.push("# HELP sentinel_provider_height_lag_blocks Blocks behind the highest provider at the last probe");
    out.push("# TYPE sentinel_provider_height_lag_blocks gauge");
    for (const p of h.providers) if (p.heightLag !== undefined) out.push(`sentinel_provider_height_lag_blocks{provider="${esc(p.provider)}"} ${p.heightLag}`);
  }
  const open = rt.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE closed_at IS NULL").get() as { n: number };
  out.push("# HELP sentinel_open_incidents Open provider incidents");
  out.push("# TYPE sentinel_open_incidents gauge");
  out.push(`sentinel_open_incidents ${open.n}`);
  out.push("# HELP sentinel_inflight_inspections Inspections currently running");
  out.push("# TYPE sentinel_inflight_inspections gauge");
  out.push(`sentinel_inflight_inspections ${rt.inflightCount}`);
  return out.join("\n") + "\n";
}

export function startMetricsServer(rt: Runtime, host: string, port: number): Promise<Server> {
  const srv = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(renderMetrics(rt));
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve(srv));
  });
}
