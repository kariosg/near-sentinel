import { z } from "zod";

const bool = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

/** Every setting the API reads. Validated once at boot; the process refuses to start on bad config. */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Optional override of the default providers: "name=url|operator,name=url|operator" */
  RPC_URLS: z.string().optional(),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  MIN_INDEPENDENT_OPERATORS: z.coerce.number().int().min(1).max(10).default(2),
  /** Local development only: allow localhost/private RPC URLs (fault-injection proxy). */
  ALLOW_PRIVATE_RPC: bool,

  /** Optional: the deployed Sentinel Guard contract shown by default in the dashboard (e.g. guard.you.testnet). */
  GUARD_CONTRACT_ID: z
    .string()
    .regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "GUARD_CONTRACT_ID must be a NEAR account ID")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  VAULT_CONTRACT_ID: z
    .string()
    .regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "VAULT_CONTRACT_ID must be a NEAR account ID")
    .optional()
    .or(z.literal("").transform(() => undefined)),

  DATA_DIR: z.string().default("./data"),
  /** Comma-separated SHA-256 hex digests of API keys. Empty = protected endpoints disabled. */
  API_KEYS_SHA256: csv.pipe(z.array(z.string().regex(/^[a-f0-9]{64}$/, "API_KEYS_SHA256 entries must be 64-char lowercase hex"))),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  INSPECT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  TRUST_PROXY: bool,
  CORS_ORIGINS: csv,

  PROBE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  CAPABILITY_INTERVAL_MS: z.coerce.number().int().min(60_000).default(600_000),
  LAG_THRESHOLD_BLOCKS: z.coerce.number().int().min(1).default(50),
  /** Disable the background prober (tests). */
  DISABLE_PROBER: bool,

  /** Prometheus metrics listener. Bound to localhost; 0 disables it. */
  METRICS_HOST: z.string().default("127.0.0.1"),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),

  /** Built dashboard to serve at "/". Auto-detected when unset. */
  WEB_DIST: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  return r.data;
}
