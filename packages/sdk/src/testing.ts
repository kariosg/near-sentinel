/**
 * @near-sentinel/sdk/testing — deterministic fault simulation.
 *
 *  - startMockRpc():   a scriptable fake NEAR JSON-RPC server (no network, fully deterministic)
 *  - startFaultProxy(): a proxy in front of a REAL RPC that injects faults per method
 *
 * Results from these tools are SIMULATED and must never be mixed with production measurements.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Fault =
  | { type: "none" }
  | { type: "delay"; ms: number }
  /** Never answer (client times out). */
  | { type: "hang" }
  /** Forward to upstream (the tx IS delivered), then never answer the client. Proxy only. */
  | { type: "forward-then-hang" }
  /** Destroy the TCP connection. */
  | { type: "reset" }
  | { type: "malformed" }
  | { type: "rate-limit" }
  | { type: "http-502" }
  | { type: "oversized"; bytes: number }
  /** Answer UNKNOWN_TRANSACTION regardless of truth (simulates a stale / lagging node). */
  | { type: "stale-unknown-tx" };

/**
 * What the mock answers for one call:
 *  - `{ result }` / `{ error }`: a JSON-RPC answer, optionally after `delayMs` and with a custom `httpStatus`
 *  - `{ fault }`: a transport-level fault instead of an answer
 */
export type MockAnswer =
  | { result: unknown; delayMs?: number; httpStatus?: number }
  | { error: unknown; delayMs?: number; httpStatus?: number }
  | { fault: Exclude<Fault, { type: "forward-then-hang" | "delay" | "none" }> };

export type MockHandler = (method: string, params: any) => MockAnswer | Promise<MockAnswer>;

export interface RunningServer {
  url: string;
  server: Server;
  requests: Array<{ method: string; params: unknown; at: number }>;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function applyFault(f: Fault, res: ServerResponse, id: unknown): boolean {
  switch (f.type) {
    case "hang":
    case "forward-then-hang":
      return true; // leave the socket open; client deadline fires
    case "reset":
      res.socket?.destroy();
      return true;
    case "malformed":
      res.writeHead(200, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","result": {broken');
      return true;
    case "rate-limit":
      res.writeHead(429, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -429, message: "Too many requests", name: "HANDLER_ERROR", cause: { name: "TOO_MANY_REQUESTS" } } }),
      );
      return true;
    case "http-502":
      res.writeHead(502, { "content-type": "text/html" }).end("<html>Bad Gateway</html>");
      return true;
    case "oversized": {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(f.bytes)}"}`);
      return true;
    }
    case "stale-unknown-tx":
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", cause: { name: "UNKNOWN_TRANSACTION", info: {} } },
        }),
      );
      return true;
    default:
      return false;
  }
}

function listen(server: Server, port = 0): Promise<string> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function closer(server: Server) {
  return () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
}

/** Scriptable fake RPC. The handler decides the answer for every call. */
export async function startMockRpc(handler: MockHandler, port = 0): Promise<RunningServer> {
  const requests: RunningServer["requests"] = [];
  const server = createServer(async (req, res) => {
    let body: any;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400).end();
      return;
    }
    requests.push({ method: body.method, params: body.params, at: Date.now() });
    const out = await handler(body.method, body.params);
    if ("fault" in out) {
      applyFault(out.fault, res, body.id);
      return;
    }
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    if (res.destroyed) return;
    const payload = "result" in out ? { result: out.result } : { error: out.error };
    res
      .writeHead(out.httpStatus ?? 200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
  });
  const url = await listen(server, port);
  return { url, server, requests, close: closer(server) };
}

export interface FaultProxy extends RunningServer {
  /** Set the fault for a method ("*" = all methods). */
  setFault(method: string, fault: Fault): void;
  clearFaults(): void;
}

/**
 * Proxy in front of a real RPC endpoint. Faults are chosen per JSON-RPC method.
 * `forward-then-hang` reproduces the most dangerous real-world failure: the transaction
 * reaches the chain, but the client never learns it.
 */
export async function startFaultProxy(upstream: string, port = 0): Promise<FaultProxy> {
  const faults = new Map<string, Fault>();
  const requests: RunningServer["requests"] = [];
  const server = createServer(async (req, res) => {
    let body: any;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400).end();
      return;
    }
    requests.push({ method: body.method, params: body.params, at: Date.now() });
    const f = faults.get(body.method) ?? faults.get("*") ?? { type: "none" };
    const forward = () =>
      fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (f.type === "forward-then-hang") {
      forward().catch(() => {});
      return; // never answer
    }
    if (f.type === "delay") await new Promise((r) => setTimeout(r, f.ms));
    else if (f.type !== "none" && applyFault(f, res, body.id)) return;
    try {
      const up = await forward();
      const text = await up.text();
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(text);
    } catch (e: any) {
      res.writeHead(502).end(String(e?.message ?? e));
    }
  });
  const url = await listen(server, port);
  return {
    url,
    server,
    requests,
    close: closer(server),
    setFault: (m, f) => void faults.set(m, f),
    clearFaults: () => faults.clear(),
  };
}
