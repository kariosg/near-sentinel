import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { startMetricsServer } from "./metrics.js";

const env = loadEnv();
const { app, runtime, prober, db } = await buildApp(env);

if (!env.DISABLE_PROBER) {
  prober.on("error", (e) => app.log.warn({ err: e }, "provider probe failed"));
  prober.start();
}
const metricsServer = env.METRICS_PORT ? await startMetricsServer(runtime, env.METRICS_HOST, env.METRICS_PORT) : undefined;

await app.listen({ host: env.HOST, port: env.PORT });
app.log.info(
  {
    network: env.NEAR_NETWORK,
    providers: runtime.sentinel.providers.map((p) => p.name),
    protectedEndpoints: env.API_KEYS_SHA256.length ? "enabled" : "disabled (no API_KEYS_SHA256)",
    metrics: metricsServer ? `http://${env.METRICS_HOST}:${env.METRICS_PORT}/metrics` : "disabled",
  },
  "NEAR Sentinel API ready (read-only: never signs or submits transactions)",
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  try {
    prober.stop();
    await app.close(); // stops accepting, drains in-flight requests, closes SSE streams
    await new Promise<void>((r) => (metricsServer ? metricsServer.close(() => r()) : r()));
    db.close();
    clearTimeout(force);
    process.exit(0);
  } catch (e) {
    app.log.error({ err: e }, "shutdown error");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
