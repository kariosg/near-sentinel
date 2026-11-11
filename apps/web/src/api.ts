import type { AllowanceCheck, Diagnostic, InspectionResult, IntentCheck, ProviderHealth, RetryRecommendation } from "@near-sentinel/sdk";

export type { AllowanceCheck, Diagnostic, InspectionResult, IntentCheck, ProviderHealth, RetryRecommendation };
export type { ReceiptNode, TxState, RetryVerdict } from "@near-sentinel/sdk";

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError(0, "API_UNREACHABLE", "The Sentinel API is not reachable. Is the server running?");
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, "BAD_RESPONSE", `Unexpected response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const e = (body as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `HTTP ${res.status}`, e?.requestId);
  }
  return body as T;
}

/* --------------------------------- shapes --------------------------------- */

export type HealthRow = Omit<ProviderHealth, "observations">;
export interface HealthSnapshot {
  source: string;
  checkedAt: string;
  providers: HealthRow[];
}
export interface ProvidersResponse {
  network: string;
  minIndependentOperators: number;
  guardContractId: string | null;
  vaultContractId?: string | null;
  providers: Array<{ name: string; url: string; operator: string; archivalDeclared: boolean | null; custom: boolean }>;
}
export interface MetricsResponse {
  since: string;
  providers: Array<{
    provider: string;
    operator: string;
    requests: number;
    ok: number;
    rpcErrors: number;
    failures: Record<string, number>;
    answerRate: number | null;
    latencyMs: { p50: number | null; p95: number | null; p99: number | null; samples: number };
    lastObservedAt?: string;
    sufficientSample: boolean;
  }>;
}
export interface HistoryResponse {
  hours: number;
  samples: Array<{ at: string; provider: string; reachable: number; latencyMs: number; height: number | null; lag: number | null; errorKind: string | null }>;
}
export interface Incident {
  id: number;
  provider: string;
  kind: string;
  severity: "critical" | "major" | "minor" | "info";
  summary: string;
  evidence: unknown;
  openedAt: string;
  closedAt: string | null;
}
export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}
export interface BenchmarkRun {
  id: string;
  kind: "real" | "simulated";
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  finishedAt: string | null;
  params: unknown;
  result: any;
}
export interface ReportSummary {
  id: string;
  createdAt: string;
  txHash: string;
  verdict: string;
  state: string;
}
export type Inspection = InspectionResult & { reportId?: string };

export interface InspectInput {
  transactionHash?: string;
  senderAccountId?: string;
  signedTransactionBase64?: string;
}

/* -------------------------------- endpoints -------------------------------- */

export interface IdentityChallenge {
  nonce: string;
  expiresAt: string;
  message: string;
  recipient: string;
  optional: true;
}
export interface IdentityResult {
  verified: true;
  accountId: string;
  publicKey: string;
  network: string;
  keyCheckedOn: string;
  verifiedAt: string;
}

export interface DemoRun {
  simulated: true;
  note: string;
  durationMs: number;
  runs: Array<{ scenario: string; agent: "naive" | "guarded"; transfers: number; receivedNear: number; intendedNear: number; log: string[] }>;
}

export const api = {
  demoRun: () => request<DemoRun>("/api/v1/demo/run", { method: "POST", body: "{}" }),
  health: () => request<{ status: string; version: string; sdk: string }>("/health"),
  ready: () => request<{ ready: boolean; reachableProviders: number; lastProbeAt: string | null }>("/ready"),
  providers: () => request<ProvidersResponse>("/api/v1/providers"),
  providerHealth: () => request<HealthSnapshot>("/api/v1/providers/health"),
  providerMetrics: () => request<MetricsResponse>("/api/v1/providers/metrics"),
  providerHistory: (hours: number) => request<HistoryResponse>(`/api/v1/providers/history?hours=${hours}`),
  incidents: (open = false) => request<Page<Incident>>(`/api/v1/incidents?limit=100${open ? "&open=1" : ""}`),
  benchmarks: (kind?: "real" | "simulated") => request<Page<BenchmarkRun>>(`/api/v1/benchmarks?limit=20${kind ? `&kind=${kind}` : ""}`),
  reports: () => request<Page<ReportSummary>>("/api/v1/reports?limit=10"),
  inspect: (input: InspectInput) => request<Inspection>("/api/v1/transactions/inspect", { method: "POST", body: JSON.stringify(input) }),
  intent: (q: { contract: string; payer: string; intent: string }) =>
    request<IntentCheck>(`/api/v1/intents?${new URLSearchParams(q).toString()}`),
  allowance: (q: { contract: string; owner: string; agent: string }) =>
    request<AllowanceCheck>(`/api/v1/allowance?${new URLSearchParams(q).toString()}`),
  identityChallenge: () => request<IdentityChallenge>("/api/v1/identity/challenge", { method: "POST", body: "{}" }),
  identityVerify: (b: { accountId: string; publicKey: string; signature: string; nonce: string; callbackUrl?: string }) =>
    request<IdentityResult>("/api/v1/identity/verify", { method: "POST", body: JSON.stringify(b) }),
  runBenchmark: (kind: "real" | "simulated", key: string) =>
    request<{ id: string }>("/api/v1/benchmarks/run", { method: "POST", body: JSON.stringify({ kind }), headers: key ? { authorization: `Bearer ${key}` } : {} }),
};
