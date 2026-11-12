import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import {
  assertPublicRpcUrl,
  diagnoseSubmissionError,
  isValidAccountId,
  isValidCryptoHash,
  rpcCall,
  SDK_VERSION,
  SentinelInputError,
  SentinelUrlRejectedError,
  type InspectionResult,
} from "@near-sentinel/sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "./auth.js";
import { IDENTITY_MESSAGE, IDENTITY_RECIPIENT, NonceStore, verifyNep413 } from "./identity.js";
import { BenchmarkRunner } from "./benchmarks.js";
import { audit, openDb, prune, setAuditSalt, type Db } from "./db.js";
import type { Env } from "./env.js";
import { Prober } from "./prober.js";
import { Runtime } from "./runtime.js";

export const API_VERSION = "0.1.0";

export interface AppDeps {
  app: FastifyInstance;
  runtime: Runtime;
  prober: Prober;
  benchmarks: BenchmarkRunner;
  db: Db;
}

/* --------------------------------- schemas --------------------------------- */

const hash = z.string().refine(isValidCryptoHash, "must be a base58 32-byte hash");
const account = z.string().refine(isValidAccountId, "must be a valid NEAR account ID");

const InspectBody = z
  .object({
    transactionHash: hash.optional(),
    senderAccountId: account.optional(),
    signedTransactionBase64: z.string().min(80).max(2_000_000).optional(),
    save: z.boolean().optional().default(true),
  })
  .strict()
  .refine((v) => v.signedTransactionBase64 || (v.transactionHash && v.senderAccountId), {
    message: "Provide signedTransactionBase64, or transactionHash + senderAccountId",
  });

const TxParams = z.object({ hash }).strict();
const TxQuery = z.object({ sender: account }).strict();
const Page = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const AddProvider = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "lowercase letters, digits, dashes; 2–32 chars"),
    url: z.string().url().max(2048),
    operator: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,63}$/).optional(),
  })
  .strict();
const BenchBody = z
  .object({
    kind: z.enum(["real", "simulated"]),
    rounds: z.number().int().min(1).max(60).default(30),
    intervalMs: z.number().int().min(1000).max(10_000).default(2500),
  })
  .strict();
const DiagnoseBody = z.object({ error: z.union([z.string().min(1).max(20_000), z.record(z.string(), z.unknown())]) }).strict();

/**
 * OpenAPI docs are generated from the zod schemas. Validation is done ONLY by zod in the handlers
 * (Fastify's own validator is disabled below), so there is a single source of truth.
 */
const doc = (s: z.ZodType) => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { unrepresentable: "any", io: "input", target: "draft-7" }) as Record<string, unknown>;
  return rest;
};

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new SentinelInputError(r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), r.error.issues);
  return r.data;
}

function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/* ----------------------------------- app ----------------------------------- */

export async function buildApp(env: Env, opts: { db?: Db } = {}): Promise<AppDeps> {
  setAuditSalt(env.AUDIT_IP_SALT); // before openDb: its one-time pass hashes any raw audit-log IPs with this salt
  const db = opts.db ?? openDb(join(env.DATA_DIR, "sentinel.db"));
  // Apply retention once at start, so it also runs when the prober is disabled. Never blocks boot.
  try {
    prune(db);
  } catch {
    /* retention is best-effort */
  }
  const runtime = new Runtime(env, db);
  const prober = new Prober(runtime);
  const benchmarks = new BenchmarkRunner(runtime);

  const app = Fastify({
    logger:
      env.LOG_LEVEL === "silent"
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: { paths: ["req.headers.authorization", 'req.headers["x-api-key"]', "req.headers.cookie"], censor: "[redacted]" },
            // Privacy: request logs carry method and URL only, never the client IP or port.
            serializers: { req: (req: { method?: string; url?: string; id?: unknown }) => ({ id: req.id, method: req.method, url: req.url }) },
          },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 2_500_000,
    requestIdHeader: false,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(h) ? h : randomUUID();
    },
  });

  // Route schemas are documentation only; zod validates in each handler (see `parse`).
  app.setValidatorCompiler(() => () => true);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    // Anti-clickjacking for direct deployments (no reverse proxy). Restricts framing only, not scripts or styles.
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "frame-ancestors 'none'");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  await app.register(fastifyCors, { origin: env.CORS_ORIGINS.length ? env.CORS_ORIGINS : false });
  await app.register(fastifyRateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    // Only the API is rate-limited. Static dashboard assets (JS, CSS, favicon, OpenAPI UI) are cheap
    // and cacheable; limiting them made a normal dashboard session hit 429 on the favicon.
    allowList: (req) => req.url === "/health" || req.url === "/ready" || !req.url.startsWith("/api/"),
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      error: { code: "RATE_LIMITED", message: `Rate limit exceeded: ${ctx.max} requests per ${ctx.after}.`, requestId: req.id },
    }),
  });
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "NEAR Sentinel API",
        version: API_VERSION,
        description:
          "Read-only transaction-safety and RPC evidence API for NEAR. Sentinel never signs or submits transactions. " +
          "Every verdict includes the provider observations it was derived from.",
      },
      components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer" } } },
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof SentinelInputError) return reply.code(400).send({ error: { code: "INVALID_INPUT", message: err.message, requestId: req.id } });
    if (err instanceof SentinelUrlRejectedError) return reply.code(400).send({ error: { code: "URL_REJECTED", message: err.message, requestId: req.id } });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, requestId: req.id } });
    if (err.statusCode === 429) return reply.code(429).send(err.error ? { error: err.error } : { error: { code: "RATE_LIMITED", message: err.message, requestId: req.id } });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal error", requestId: req.id } });
  });

  const inspectLimit = { config: { rateLimit: { max: env.INSPECT_RATE_LIMIT_MAX, timeWindow: "1 minute" } } };

  async function inspectAndSave(input: Parameters<Runtime["inspect"]>[0], save: boolean): Promise<InspectionResult & { reportId?: string }> {
    const i = await runtime.inspect(input);
    if (!save) return i;
    const report = runtime.sentinel.exportDiagnosticReport(i);
    const id = randomUUID();
    db.prepare("INSERT INTO reports (id, created_at, tx_hash, verdict, state, body) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      report.generatedAt,
      i.txHash,
      i.retryRecommendation.verdict,
      i.state,
      JSON.stringify(report),
    );
    return { ...i, reportId: id };
  }

  /* ------------------------------ system routes ------------------------------ */

  app.get("/health", { schema: { tags: ["system"], summary: "Liveness" } }, async () => ({ status: "ok", version: API_VERSION, sdk: SDK_VERSION }));

  app.get("/ready", { schema: { tags: ["system"], summary: "Readiness: DB writable and at least one provider reachable in the last probe" } }, async (req, reply) => {
    let dbOk = false;
    try {
      db.prepare("SELECT 1").get();
      dbOk = true;
    } catch {}
    const h = runtime.lastHealth;
    const reachable = h?.providers.filter((p) => p.reachable).length ?? 0;
    const ready = dbOk && reachable > 0;
    return reply.code(ready ? 200 : 503).send({
      ready,
      db: dbOk,
      lastProbeAt: h?.checkedAt ?? null,
      reachableProviders: reachable,
      reason: !dbOk ? "database unavailable" : !h ? "first provider probe not finished" : reachable === 0 ? "no provider reachable" : undefined,
    });
  });

  /* ----------------------------- provider routes ----------------------------- */

  app.get("/api/v1/providers", { schema: { tags: ["providers"], summary: "Configured providers" } }, async () => {
    const custom = new Set(runtime.customProviders().map((p) => p.name));
    return {
      network: runtime.sentinel.network,
      minIndependentOperators: env.MIN_INDEPENDENT_OPERATORS,
      guardContractId: env.GUARD_CONTRACT_ID ?? null,
      vaultContractId: env.VAULT_CONTRACT_ID ?? null,
      providers: runtime.sentinel.providers.map((p) => ({ name: p.name, url: p.url, operator: p.operator, archivalDeclared: p.archival ?? null, custom: custom.has(p.name) })),
    };
  });

  app.get("/api/v1/providers/health", { ...inspectLimit, schema: { tags: ["providers"], summary: "Latest provider health snapshot (from the background prober), or a fresh probe" } }, async (req) => {
    const fresh = (req.query as any)?.fresh === "1";
    if (fresh || !runtime.lastHealth) await prober.runOnce();
    return { source: "background-prober", ...runtime.lastHealth! };
  });

  app.get("/api/v1/providers/metrics", { schema: { tags: ["providers"], summary: "Rolling per-provider request metrics since process start" } }, async () => ({
    since: "process start",
    providers: runtime.metrics.snapshot(),
  }));

  app.get("/api/v1/providers/history", { schema: { tags: ["providers"], summary: "Health samples for the last N hours (default 6, max 168)" } }, async (req) => {
    const hours = Math.min(168, Math.max(1, Number((req.query as any)?.hours ?? 6) || 6));
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = db
      .prepare("SELECT at, provider, reachable, latency_ms AS latencyMs, height, lag, error_kind AS errorKind FROM provider_samples WHERE at >= ? ORDER BY at")
      .all(since);
    return { hours, samples: rows };
  });

  app.post(
    "/api/v1/providers",
    {
      preHandler: requireApiKey(env.API_KEYS_SHA256, db, "provider.add"),
      schema: { tags: ["providers"], summary: "Register a custom RPC provider (API key). SSRF-guarded; must serve the configured network.", body: doc(AddProvider), security: [{ apiKey: [] }] },
    },
    async (req, reply) => {
      const b = parse(AddProvider, req.body);
      if (runtime.sentinel.providers.some((p) => p.name === b.name)) throw new HttpError(409, "PROVIDER_EXISTS", `Provider ${b.name} already exists`);
      const url = await assertPublicRpcUrl(b.url, { allowPrivateNetworks: env.ALLOW_PRIVATE_RPC, allowHttp: env.ALLOW_PRIVATE_RPC });
      const probe = await rpcCall({ name: b.name, url: url.toString() }, "status", [], {
        timeoutMs: env.RPC_TIMEOUT_MS,
        maxResponseBytes: 256_000,
        fetch: runtime.fetchImpl,
      });
      const chain = (probe.result as any)?.chain_id;
      if (!probe.ok || chain !== env.NEAR_NETWORK) {
        audit(db, { requestId: req.id, ip: req.ip, action: "provider.add", outcome: "rejected", detail: { name: b.name, chain, error: probe.error } });
        throw new HttpError(422, "PROVIDER_VALIDATION_FAILED", probe.ok ? `Endpoint serves chain_id=${chain}, expected ${env.NEAR_NETWORK}` : `Endpoint did not answer status: ${probe.error?.message}`);
      }
      const operator = b.operator ?? url.hostname.split(".").slice(-2).join(".");
      db.prepare("INSERT INTO custom_providers (name, url, operator, added_at) VALUES (?, ?, ?, ?)").run(b.name, url.toString(), operator, new Date().toISOString());
      runtime.rebuild();
      audit(db, { requestId: req.id, ip: req.ip, action: "provider.add", outcome: "ok", detail: { name: b.name, url: url.origin } });
      return reply.code(201).send({ name: b.name, url: url.toString(), operator, chainId: chain });
    },
  );

  app.delete(
    "/api/v1/providers/:name",
    { preHandler: requireApiKey(env.API_KEYS_SHA256, db, "provider.remove"), schema: { tags: ["providers"], summary: "Remove a custom provider (API key)", security: [{ apiKey: [] }] } },
    async (req, reply) => {
      const name = String((req.params as any).name);
      const r = db.prepare("DELETE FROM custom_providers WHERE name = ?").run(name);
      if (Number(r.changes) === 0) throw new HttpError(404, "NOT_FOUND", `No custom provider named ${name}`);
      runtime.rebuild();
      audit(db, { requestId: req.id, ip: req.ip, action: "provider.remove", outcome: "ok", detail: { name } });
      return reply.code(204).send();
    },
  );

  /* --------------------------- transaction routes --------------------------- */

  app.post(
    "/api/v1/transactions/inspect",
    { ...inspectLimit, schema: { tags: ["transactions"], summary: "Inspect a transaction across providers (state, receipts, diagnostics, retry verdict)", body: doc(InspectBody) } },
    async (req) => {
      const b = parse(InspectBody, req.body);
      return jsonSafe(await inspectAndSave(b, b.save));
    },
  );

  app.post(
    "/api/v1/transactions/retry-check",
    { ...inspectLimit, schema: { tags: ["transactions"], summary: "Is it safe to sign a new transaction for this intent? Send the signed tx for a definitive answer.", body: doc(InspectBody) } },
    async (req) => {
      const b = parse(InspectBody, req.body);
      const i = await inspectAndSave(b, b.save);
      return jsonSafe({
        txHash: i.txHash,
        state: i.state,
        verdict: i.retryRecommendation.verdict,
        recommendation: i.retryRecommendation,
        diagnostics: i.diagnostics,
        providers: i.providers,
        agreement: i.agreement,
        reportId: i.reportId,
      });
    },
  );

  const byHash = async (req: any) => {
    const { hash: h } = parse(TxParams, req.params);
    const { sender } = parse(TxQuery, req.query);
    return inspectAndSave({ transactionHash: h, senderAccountId: sender }, false);
  };
  app.get("/api/v1/transactions/:hash", { ...inspectLimit, schema: { tags: ["transactions"], summary: "Inspect by hash (?sender=account)" } }, async (req) => jsonSafe(await byHash(req)));
  app.get("/api/v1/transactions/:hash/receipts", { ...inspectLimit, schema: { tags: ["transactions"], summary: "Receipt execution graph" } }, async (req) => {
    const i = await byHash(req);
    return jsonSafe({ txHash: i.txHash, state: i.state, receiptCount: i.receiptCount, receiptTree: i.receiptTree ?? null });
  });
  app.get("/api/v1/transactions/:hash/diagnostics", { ...inspectLimit, schema: { tags: ["transactions"], summary: "Diagnostics with evidence" } }, async (req) => {
    const i = await byHash(req);
    return jsonSafe({ txHash: i.txHash, state: i.state, diagnostics: i.diagnostics, retryRecommendation: i.retryRecommendation });
  });

  const IntentQuery = z
    .object({
      contract: z.string().optional(),
      payer: z.string(),
      intent: z.string(),
    })
    .strict();
  app.get(
    "/api/v1/intents",
    { ...inspectLimit, schema: { tags: ["guard"], summary: "What a Sentinel Guard contract recorded for (payer, intent). Read-only view call. ?contract=&payer=&intent= (contract defaults to GUARD_CONTRACT_ID)" } },
    async (req) => {
      const q = parse(IntentQuery, req.query);
      const contractId = q.contract ?? env.GUARD_CONTRACT_ID;
      if (!contractId) throw new SentinelInputError("contract is required (no GUARD_CONTRACT_ID configured)");
      return jsonSafe(await runtime.sentinel.checkIntent({ contractId, payerId: q.payer, intentId: q.intent }));
    },
  );

  const AllowanceQuery = z
    .object({
      contract: z.string().optional(),
      owner: z.string(),
      agent: z.string(),
    })
    .strict();
  app.get(
    "/api/v1/allowance",
    { ...inspectLimit, schema: { tags: ["vault"], summary: "How much an agent may spend now from a Sentinel Vault allowance (read-only get_policy on every provider; the smallest available amount wins). ?contract=&owner=&agent= (contract defaults to VAULT_CONTRACT_ID)" } },
    async (req) => {
      const q = parse(AllowanceQuery, req.query);
      const contractId = q.contract ?? env.VAULT_CONTRACT_ID;
      if (!contractId) throw new SentinelInputError("contract is required (no VAULT_CONTRACT_ID configured)");
      return jsonSafe(await runtime.sentinel.checkSpendAllowance({ contractId, ownerId: q.owner, agentId: q.agent }));
    },
  );

  const AgentKeysQuery = z
    .object({
      account: z.string(),
      vault: z.string().optional(),
    })
    .strict();
  app.get(
    "/api/v1/agent-keys",
    { ...inspectLimit, schema: { tags: ["vault"], summary: "Can this agent's keys drain its account? Read-only view_access_key_list on every provider; grades each key. ?account=&vault= (without a vault, function-call keys are graded 'review': least privilege needs the vault to check against)" } },
    async (req) => {
      const q = parse(AgentKeysQuery, req.query);
      const vaultContractId = q.vault; // no silent default: grading against someone else's vault would mislead
      return jsonSafe(await runtime.sentinel.auditAgentKeys({ accountId: q.account, ...(vaultContractId ? { vaultContractId } : {}) }));
    },
  );

  const PreflightQuery = z
    .object({
      contract: z.string().optional(),
      owner: z.string(),
      agent: z.string(),
      receiver: z.string(),
      amount: z.string(),
      intent: z.string().optional(),
    })
    .strict();
  app.get(
    "/api/v1/spend-preflight",
    { ...inspectLimit, schema: { tags: ["vault"], summary: "Would the Vault accept this spend now? Mirrors spend() checks in contract order (advisory; the contract is the final judge). ?contract=&owner=&agent=&receiver=&amount=<yoctoNEAR>&intent= (contract defaults to VAULT_CONTRACT_ID)" } },
    async (req) => {
      const q = parse(PreflightQuery, req.query);
      const contractId = q.contract ?? env.VAULT_CONTRACT_ID;
      if (!contractId) throw new SentinelInputError("contract is required (no VAULT_CONTRACT_ID configured)");
      return jsonSafe(
        await runtime.sentinel.preflightSpend({ contractId, ownerId: q.owner, agentId: q.agent, receiverId: q.receiver, amountYocto: q.amount, ...(q.intent !== undefined ? { intentId: q.intent } : {}) }),
      );
    },
  );

  /* ------------------- optional account verification (NEP-413) ------------------- */
  // A label only: no session, no cookie, nothing stored except short-lived single-use nonces.
  const nonces = new NonceStore();
  const identityLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  app.post("/api/v1/identity/challenge", { ...identityLimit, schema: { tags: ["identity"], summary: "Optional: get a single-use NEP-413 message to sign (expires in 5 min)" } }, async () => ({
    ...nonces.issue(),
    message: IDENTITY_MESSAGE,
    recipient: IDENTITY_RECIPIENT,
    optional: true,
  }));
  const VerifyBody = z
    .object({
      accountId: z.string().refine(isValidAccountId, "Invalid NEAR account ID"),
      publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, "publicKey must be ed25519:<base58>"),
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "signature must be a base64 ed25519 signature"),
      nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "nonce must be the base64 value from /identity/challenge"),
      callbackUrl: z.string().url().max(2048).optional(),
    })
    .strict();
  app.post("/api/v1/identity/verify", { ...identityLimit, schema: { tags: ["identity"], summary: "Optional: verify a NEP-413 signature and that the key is a FullAccess key of the account", body: doc(VerifyBody) } }, async (req) => {
    const b = parse(VerifyBody, req.body);
    // Burn the nonce before anything else: one attempt per challenge.
    if (!nonces.consume(b.nonce)) throw new SentinelInputError("Challenge expired or already used. Request a new one.");
    let ok: boolean;
    try {
      ok = verifyNep413({ publicKey: b.publicKey, signatureBase64: b.signature, message: IDENTITY_MESSAGE, nonce: Buffer.from(b.nonce, "base64"), recipient: IDENTITY_RECIPIENT, callbackUrl: b.callbackUrl });
    } catch (e) {
      throw new SentinelInputError(`Invalid public key: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ok) throw new SentinelInputError("Signature does not verify for this challenge and key.");
    const trail = await runtime.sentinel.read<any>("query", { request_type: "view_access_key", finality: "final", account_id: b.accountId, public_key: b.publicKey });
    const last = trail.at(-1);
    if (!last?.ok) throw new HttpError(503, "PROVIDERS_UNAVAILABLE", "Could not read the access key from any provider; try again.");
    if (typeof last.result?.error === "string" || last.result?.permission !== "FullAccess") {
      throw new SentinelInputError(`${b.publicKey} is not a FullAccess key of ${b.accountId} on ${runtime.sentinel.network}.`);
    }
    return { verified: true, accountId: b.accountId, publicKey: b.publicKey, network: runtime.sentinel.network, keyCheckedOn: last.provider, atBlock: last.result.block_height, verifiedAt: new Date().toISOString() };
  });

  app.post("/api/v1/diagnose/error", { schema: { tags: ["transactions"], summary: "Classify an error returned when submitting a transaction (no network calls)", body: doc(DiagnoseBody) } }, async (req) => {
    const b = parse(DiagnoseBody, req.body);
    return jsonSafe(diagnoseSubmissionError(b.error));
  });

  /* ------------------------- reports, incidents, bench ------------------------ */

  app.get("/api/v1/reports/:id", { schema: { tags: ["reports"], summary: "Saved diagnostic report (JSON)" } }, async (req) => {
    const id = String((req.params as any).id);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "INVALID_INPUT", "id must be a UUID");
    const row = db.prepare("SELECT body FROM reports WHERE id = ?").get(id) as { body: string } | undefined;
    if (!row) throw new HttpError(404, "NOT_FOUND", "Report not found (reports are kept 30 days)");
    return JSON.parse(row.body);
  });

  app.get("/api/v1/reports", { schema: { tags: ["reports"], summary: "Recent reports (paginated, newest first)" } }, async (req) => {
    const q = parse(Page, req.query);
    const rows = db
      .prepare("SELECT rowid AS cursor, id, created_at AS createdAt, tx_hash AS txHash, verdict, state FROM reports WHERE (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?")
      .all(q.cursor ?? null, q.cursor ?? null, q.limit) as any[];
    return { items: rows.map(({ cursor: _c, ...r }) => r), nextCursor: rows.length === q.limit ? rows.at(-1).cursor : null };
  });

  app.get("/api/v1/incidents", { schema: { tags: ["incidents"], summary: "Provider incidents (paginated, newest first); ?open=1 for open only" } }, async (req) => {
    const { open, ...rest } = (req.query ?? {}) as any;
    const q = parse(Page, rest);
    const onlyOpen = open === "1" ? 1 : 0;
    const rows = db
      .prepare(
        `SELECT id, provider, kind, severity, summary, evidence, opened_at AS openedAt, closed_at AS closedAt FROM incidents
         WHERE (? IS NULL OR id < ?) AND (? = 0 OR closed_at IS NULL) ORDER BY id DESC LIMIT ?`,
      )
      .all(q.cursor ?? null, q.cursor ?? null, onlyOpen, q.limit) as any[];
    return {
      items: rows.map((r) => ({ ...r, evidence: JSON.parse(r.evidence) })),
      nextCursor: rows.length === q.limit ? rows.at(-1).id : null,
    };
  });

  app.get("/api/v1/benchmarks", { schema: { tags: ["benchmarks"], summary: "Benchmark runs (paginated). ?kind=real|simulated" } }, async (req) => {
    const { kind, ...rest } = (req.query ?? {}) as any;
    const q = parse(Page, rest);
    if (kind !== undefined && kind !== "real" && kind !== "simulated") throw new HttpError(400, "INVALID_INPUT", "kind must be real or simulated");
    const rows = db
      .prepare(
        `SELECT rowid AS cursor, id, kind, status, started_at AS startedAt, finished_at AS finishedAt, params, result FROM benchmark_runs
         WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`,
      )
      .all(kind ?? null, kind ?? null, q.cursor ?? null, q.cursor ?? null, q.limit) as any[];
    return {
      items: rows.map(({ cursor: _c, ...r }) => ({ ...r, params: JSON.parse(r.params), result: r.result ? JSON.parse(r.result) : null })),
      nextCursor: rows.length === q.limit ? rows.at(-1).cursor : null,
    };
  });

  app.get("/api/v1/benchmarks/:id", { schema: { tags: ["benchmarks"], summary: "One benchmark run" } }, async (req) => {
    const row = db.prepare("SELECT id, kind, status, started_at AS startedAt, finished_at AS finishedAt, params, result FROM benchmark_runs WHERE id = ?").get(String((req.params as any).id)) as any;
    if (!row) throw new HttpError(404, "NOT_FOUND", "Benchmark not found");
    return { ...row, params: JSON.parse(row.params), result: row.result ? JSON.parse(row.result) : null };
  });

  // The simulated benchmark only talks to local in-process mock RPCs (no outbound traffic), so anyone
  // may run it (one run at a time server-wide, rate-limited). The real benchmark calls public RPC
  // providers and stays behind an API key.
  /* ------------- the naive-vs-guarded demo, live (local simulated chain only) ------------- */
  // Public: it only talks to an in-process mock chain on 127.0.0.1 with a throwaway in-memory key; no real
  // network, no funds. Concurrent callers share one run.
  type DemoRow = { name: string; which: "naive" | "guarded"; transfers: number; received: bigint; lines: string[]; run: { signed: unknown[]; decisions: string[] } };
  let demoRun: Promise<DemoRow[]> | undefined;
  app.post(
    "/api/v1/demo/run",
    {
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: { tags: ["demo"], summary: "Run the naive-vs-guarded agent demo on a local simulated chain (no real network, no funds) and return what each agent paid." },
    },
    async () => {
      const t0 = Date.now();
      demoRun ??= (async () => {
        const modId = "@near-sentinel/agent-demo"; // untyped workspace example package
        const mod = (await import(modId)) as { runSimulatedDemo: () => Promise<DemoRow[]> };
        return mod.runSimulatedDemo();
      })().finally(() => {
        demoRun = undefined;
      });
      const rows = await demoRun;
      return {
        simulated: true,
        note: "SIMULATED: local mock chain and a fault-injection proxy that delivers the payment but drops the reply. No real network, no real funds.",
        durationMs: Date.now() - t0,
        runs: rows.map((r) => ({ scenario: r.name, agent: r.which, transfers: r.transfers, receivedNear: Number(r.received / 10n ** 21n) / 1000, intendedNear: 1, signedTransactions: r.run.signed.length, decisions: r.run.decisions, log: r.lines })),
      };
    },
  );

  const benchKeyCheck = requireApiKey(env.API_KEYS_SHA256, db, "benchmark.run");
  app.post(
    "/api/v1/benchmarks/run",
    {
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      preHandler: async (req, reply) => {
        if ((req.body as { kind?: unknown } | undefined)?.kind === "simulated") return;
        return benchKeyCheck(req, reply);
      },
      schema: {
        tags: ["benchmarks"],
        summary: "Start a benchmark. kind=simulated is public (local mocks only); kind=real requires an API key. Returns 202 with the run id.",
        body: doc(BenchBody),
        security: [{}, { apiKey: [] }],
      },
    },
    async (req, reply) => {
      const b = parse(BenchBody, req.body);
      const id = benchmarks.start(b.kind, { rounds: b.rounds, intervalMs: b.intervalMs });
      audit(db, { requestId: req.id, ip: req.ip, action: "benchmark.run", outcome: "started", detail: { id, ...b } });
      return reply.code(202).send({ id, kind: b.kind, status: "running", poll: `/api/v1/benchmarks/${id}` });
    },
  );

  /* ---------------------------------- events ---------------------------------- */

  const sseClients = new Set<import("node:http").ServerResponse>();
  const ssePerIp = new Map<string, number>();
  const SSE_MAX_TOTAL = 200;
  const SSE_MAX_PER_IP = 10; // one client can't take every slot
  app.get("/api/v1/events", { schema: { tags: ["system"], summary: "Server-Sent Events: health snapshots and incidents" } }, (req, reply) => {
    if (sseClients.size >= SSE_MAX_TOTAL) throw new HttpError(503, "TOO_MANY_STREAMS", "Too many event streams");
    const ip = req.ip;
    if ((ssePerIp.get(ip) ?? 0) >= SSE_MAX_PER_IP) throw new HttpError(429, "TOO_MANY_STREAMS", `At most ${SSE_MAX_PER_IP} event streams per client`);
    ssePerIp.set(ip, (ssePerIp.get(ip) ?? 0) + 1);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-request-id": req.id });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write(": connected\n\n"); // flush headers now, even before the first snapshot exists
    if (runtime.lastHealth) send("health", runtime.lastHealth);
    const onHealth = (s: unknown) => send("health", s);
    const onIncident = (i: unknown) => send("incident", i);
    prober.on("health", onHealth);
    prober.on("incident", onIncident);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    sseClients.add(res);
    req.raw.on("close", () => {
      clearInterval(ping);
      prober.off("health", onHealth);
      prober.off("incident", onIncident);
      sseClients.delete(res);
      const n = (ssePerIp.get(ip) ?? 1) - 1;
      if (n <= 0) ssePerIp.delete(ip);
      else ssePerIp.set(ip, n);
    });
  });

  // Retention also runs hourly on its own timer, so it holds even with DISABLE_PROBER and a long-running process.
  const retention = setInterval(() => {
    try {
      prune(db);
    } catch {
      /* best-effort */
    }
  }, 60 * 60_000);
  retention.unref();

  app.addHook("onClose", async () => {
    clearInterval(retention);
    prober.stop();
    benchmarks.stopAll();
    for (const r of sseClients) r.end();
  });

  /* ------------------------------ dashboard (SPA) ------------------------------ */

  const webDist = env.WEB_DIST ? resolve(env.WEB_DIST) : [resolve("../web/dist"), resolve("apps/web/dist"), resolve("web")].find((p) => existsSync(join(p, "index.html")));
  if (webDist && existsSync(join(webDist, "index.html"))) {
    // wildcard: true serves files that exist at request time (a rebuilt bundle works without a restart).
    await app.register(fastifyStatic, { root: webDist, wildcard: true, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0]!;
      // SPA fallback ONLY for page routes. A missing asset (has a file extension) must be a real 404,
      // never index.html served as text/html in place of JavaScript.
      const isPageRoute = !/\.[a-z0-9]+$/i.test(path);
      if (req.method === "GET" && isPageRoute && !path.startsWith("/api/") && !path.startsWith("/docs")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url.split("?")[0]} not found`, requestId: req.id } });
    });
  } else {
    app.setNotFoundHandler((req, reply) =>
      reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url.split("?")[0]} not found`, requestId: req.id } }),
    );
  }

  return { app, runtime, prober, benchmarks, db };
}
