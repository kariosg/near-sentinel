import type { ProviderConfig, RpcErrorInfo, RpcObservation } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RpcCallOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  fetch?: FetchLike;
}

let nextId = 1;

export function operatorOf(p: ProviderConfig): string {
  if (p.operator) return p.operator;
  try {
    const host = new URL(p.url).hostname;
    const parts = host.split(".");
    return parts.slice(-2).join(".");
  } catch {
    return p.name;
  }
}

/** Read a response body with a hard byte cap (protects against oversized/hostile responses). */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string } | { tooLarge: true }> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  if (!res.body) return { text: await res.text() };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf) };
}

function parseRpcError(err: unknown): RpcErrorInfo {
  const e = (err ?? {}) as Record<string, any>;
  const code = typeof e.code === "number" ? e.code : undefined;
  const causeName = typeof e.cause?.name === "string" ? e.cause.name : undefined;
  const isRate = code === -429 || causeName === "TOO_MANY_REQUESTS";
  return {
    kind: isRate ? "RATE_LIMITED" : "RPC_ERROR",
    name: typeof e.name === "string" ? e.name : undefined,
    causeName,
    causeInfo: e.cause?.info,
    code,
    message: String(e.message ?? "RPC error") + (typeof e.data === "string" ? `: ${e.data}` : ""),
    data: e.data,
  };
}

/**
 * Perform exactly ONE JSON-RPC call against ONE provider and record what happened.
 * Never retries, never throws for transport/protocol failures — the failure is the evidence.
 * Throws only on programmer error.
 */
export async function rpcCall<T = unknown>(
  provider: ProviderConfig,
  method: string,
  params: unknown,
  opts: RpcCallOptions,
): Promise<RpcObservation<T>> {
  const started = Date.now();
  const observedAt = new Date(started).toISOString();
  const base = {
    provider: provider.name,
    operator: operatorOf(provider),
    url: provider.url,
    method,
    params,
    observedAt,
  };
  const done = (o: Partial<RpcObservation<T>>): RpcObservation<T> =>
    ({ ...base, ok: false, latencyMs: Date.now() - started, ...o }) as RpcObservation<T>;

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs);
  const onCallerAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  try {
    const res = await doFetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(provider.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: `ns-${nextId++}`, method, params }),
      signal: ctrl.signal,
      redirect: "error",
    });
    const body = await readCapped(res, opts.maxResponseBytes);
    if ("tooLarge" in body) {
      return done({
        httpStatus: res.status,
        error: { kind: "TOO_LARGE", message: `Response exceeded ${opts.maxResponseBytes} bytes` },
      });
    }
    let json: any;
    try {
      json = JSON.parse(body.text);
    } catch {
      if (res.status === 429) {
        return done({ httpStatus: 429, error: { kind: "RATE_LIMITED", code: 429, message: "HTTP 429" } });
      }
      return done({
        httpStatus: res.status,
        error: {
          kind: res.ok ? "MALFORMED" : "HTTP_ERROR",
          message: `${res.ok ? "Non-JSON body" : `HTTP ${res.status}`}: ${body.text.slice(0, 200)}`,
        },
      });
    }
    if (json && typeof json === "object" && json.error !== undefined && json.error !== null) {
      const info = typeof json.error === "object" ? parseRpcError(json.error) : undefined;
      if (info) {
        if (res.status === 429) info.kind = "RATE_LIMITED";
        // Provider-side request deadline (e.g. dRPC free plan: HTTP 408, code 30).
        else if (res.status === 408) info.kind = "TIMEOUT";
        return done({ httpStatus: res.status, error: info });
      }
      // Non-JSON-RPC error envelope, e.g. {"error":"This endpoint has been discontinued."}
      return done({
        httpStatus: res.status,
        error: {
          kind: res.status === 429 ? "RATE_LIMITED" : res.ok ? "MALFORMED" : "HTTP_ERROR",
          message: `HTTP ${res.status}: ${String(json.error).slice(0, 200)}`,
          data: json,
        },
      });
    }
    if (res.status === 429) {
      return done({ httpStatus: 429, error: { kind: "RATE_LIMITED", code: 429, message: "HTTP 429" } });
    }
    if (!json || typeof json !== "object" || !("result" in json) || json.result === undefined) {
      return done({
        httpStatus: res.status,
        error: { kind: res.ok ? "MALFORMED" : "HTTP_ERROR", message: "JSON-RPC response has neither result nor error" },
      });
    }
    return { ...base, ok: true, result: json.result as T, httpStatus: res.status, latencyMs: Date.now() - started };
  } catch (e: any) {
    if (timedOut) {
      return done({ error: { kind: "TIMEOUT", message: `No response within ${opts.timeoutMs}ms` } });
    }
    if (opts.signal?.aborted) {
      return done({ error: { kind: "ABORTED", message: "Cancelled by caller" } });
    }
    const msg = String(e?.cause?.code ?? e?.code ?? e?.message ?? e);
    return done({ error: { kind: "NETWORK", message: msg.slice(0, 300) } });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Run the same call against many providers concurrently. Order of output = order of input. */
export function rpcFanOut<T = unknown>(
  providers: ProviderConfig[],
  method: string,
  params: unknown,
  opts: RpcCallOptions,
): Promise<RpcObservation<T>[]> {
  return Promise.all(providers.map((p) => rpcCall<T>(p, method, params, opts)));
}

/** Any flavour of "the question was not answered in time": client deadline, HTTP 408, nearcore TIMEOUT_ERROR. */
export function isTimeout(o: RpcObservation): boolean {
  return !o.ok && (o.error?.kind === "TIMEOUT" || o.error?.causeName === "TIMEOUT_ERROR");
}

export function isUnknownTx(o: RpcObservation): boolean {
  return !o.ok && o.error?.causeName === "UNKNOWN_TRANSACTION";
}
export function isUnknownBlock(o: RpcObservation): boolean {
  return !o.ok && (o.error?.causeName === "UNKNOWN_BLOCK" || o.error?.causeName === "GARBAGE_COLLECTED_BLOCK");
}
export function isMethodNotFound(o: RpcObservation): boolean {
  if (o.ok || !o.error) return false;
  return (
    o.error.causeName === "METHOD_NOT_FOUND" ||
    o.error.code === -32601 ||
    /method not found|unsupported method|not supported/i.test(o.error.message)
  );
}
