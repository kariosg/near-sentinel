# REST API

- Base: `http://127.0.0.1:8080` (default).
- Interactive OpenAPI: **`/docs`**. JSON: `/docs/json`.
- Source: `apps/api/src/app.ts`. Tests: `apps/api/test/api.test.ts`.

All responses carry `x-request-id`. You can supply one (`[A-Za-z0-9._-]{1,64}`); otherwise it's generated. Errors always look like:

```json
{ "error": { "code": "INVALID_INPUT", "message": "transactionHash: must be a base58 32-byte hash", "requestId": "…" } }
```

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | — | Liveness. Never rate-limited. |
| GET | `/ready` | — | 200 only when the DB is writable **and** ≥ 1 provider was reachable in the last probe. Otherwise 503 with `reason`. |
| GET | `/api/v1/providers` | — | Configured providers, operators, custom flag, `guardContractId` (from `GUARD_CONTRACT_ID`, or `null`). |
| GET | `/api/v1/providers/health` | — | Latest prober snapshot (tested capabilities, lag, latency). `?fresh=1` probes now (inspect rate limit applies). |
| GET | `/api/v1/providers/metrics` | — | Rolling per-provider counters and p50/p95/p99 since start. |
| GET | `/api/v1/providers/history?hours=6` | — | Persisted health samples (max 168 h). |
| POST | `/api/v1/providers` | API key | Register `{name, url, operator?}`. SSRF-guarded; the endpoint must answer `status` with the configured `chain_id`. |
| DELETE | `/api/v1/providers/:name` | API key | Remove a custom provider. |
| POST | `/api/v1/transactions/inspect` | — | Body: `{transactionHash, senderAccountId}` **or** `{signedTransactionBase64}`; `save` (default true) stores a report. |
| POST | `/api/v1/transactions/retry-check` | — | Same body. Returns `{verdict, recommendation, diagnostics, providers, agreement, reportId}`. |
| GET | `/api/v1/transactions/:hash?sender=…` | — | Inspect by hash. |
| GET | `/api/v1/transactions/:hash/receipts?sender=…` | — | Receipt tree. |
| GET | `/api/v1/transactions/:hash/diagnostics?sender=…` | — | Diagnostics + retry recommendation. |
| POST | `/api/v1/diagnose/error` | — | `{error}` (string or object) → classification. No network calls. |
| GET | `/api/v1/intents?contract=&payer=&intent=` | — | Read-only `get_intent` view call on a Sentinel Guard contract across all providers → `{status: PAID\|PENDING\|NOT_RECORDED\|CONFLICTING\|UNKNOWN, intent?, reason, providers[]}`. `contract` defaults to `GUARD_CONTRACT_ID`. Inspect rate limit applies. |
| POST | `/api/v1/identity/challenge` | — | **Optional** account verification: returns a single-use 32-byte `nonce` (expires in 5 min), the `message` and `recipient` to sign (NEP-413). 20/min per IP. |
| POST | `/api/v1/identity/verify` | — | **Optional.** `{accountId, publicKey, signature, nonce, callbackUrl?}`. The nonce is burned on the first attempt; the ed25519 signature must match the challenge; the key must be a **FullAccess** key of the account on-chain. Returns `{verified: true, …}`. No session or cookie is created. |
| GET | `/api/v1/reports?limit&cursor` | — | Recent reports, newest first. |
| GET | `/api/v1/reports/:id` | — | Saved report (`near-sentinel/diagnostic-report@1`), kept 30 days. |
| GET | `/api/v1/incidents?open=1&limit&cursor` | — | Provider incidents. |
| GET | `/api/v1/benchmarks?kind=real\|simulated&limit&cursor` | — | Benchmark runs. |
| GET | `/api/v1/benchmarks/:id` | — | One run. |
| POST | `/api/v1/benchmarks/run` | `simulated`: public (local mocks only, 6/min per IP); `real`: API key | `{kind: "real"\|"simulated", rounds?, intervalMs?}` → 202. One run at a time (409 if busy). |
| GET | `/api/v1/events` | — | Server-Sent Events: `health`, `incident`. At most 10 streams per client IP (429) and 200 in total (503). |
| GET | `127.0.0.1:9464/metrics` | — | Prometheus. **Separate localhost-only listener**, not on the API port. |

**Authentication.**
- Send `Authorization: Bearer <key>` (or `x-api-key`).
- The server stores only SHA-256 digests (`API_KEYS_SHA256`) and compares them in constant time.
- With no keys configured, protected endpoints return **503** (fail closed).
- Every protected call, including failures, is written to `audit_log`.

**Rate limits.**
- `RATE_LIMIT_MAX` per minute per client IP for every `/api/` route. `/health`, `/ready` and static dashboard assets are not limited.
- `INSPECT_RATE_LIMIT_MAX` for routes that fan out to providers.
- `X-Forwarded-For` is ignored unless `TRUST_PROXY=1` (tested: spoofed headers do not reset the limit).

**Validation.**
- zod, strict objects: unknown fields such as `privateKey` are rejected.
- Hashes must decode to 32 bytes; account IDs must follow NEAR rules.
- Invalid input is rejected before any upstream call.
