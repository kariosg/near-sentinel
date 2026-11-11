# @near-sentinel/sdk

Evidence-based transaction inspection, retry safety and RPC provider intelligence for NEAR. Read-only: it never signs or submits.

```ts
import { NearSentinel } from "@near-sentinel/sdk";

const sentinel = new NearSentinel({
  network: "testnet", // default providers: FastNEAR, FastNEAR archival, dRPC, Intear (3 independent operators)
  // rpcProviders: [{ name: "mine", url: "https://…", operator: "me", archival: true }],
  // minIndependentOperators: 2, timeoutMs: 8000, maxResponseBytes: 8 MiB, fetch: createGuardedFetch()
});
```

## Methods

| Method | Returns |
|---|---|
| `inspectTransaction({ transactionHash, senderAccountId } \| { signedTransactionBase64 }, { signal? })` | `InspectionResult`: state, finality, receipt tree, per-provider verdicts, agreement, diagnostics, retry recommendation, raw observations |
| `checkRetrySafety(input)` | `{ verdict, recommendation, diagnostics, state, inspection }` |
| `traceReceipts(input)` | `{ root, state, inspection }` |
| `diagnoseFailure({ error })` | Classifies a submission error. No network. |
| `diagnoseFailure(input)` | Diagnostics for a tx (runs an inspection) |
| `compareProviders({ method, params })` | Groups identical answers. Allow-listed **read** methods only. |
| `getProviderHealth({ capabilities? })` | Reachability, lag, latency, **tested** capabilities (archival, `tx`, `tx_status`, `EXPERIMENTAL_tx_status`, `EXPERIMENTAL_receipt`) |
| `getProviderMetrics()` | Rolling counters and latency percentiles |
| `subscribeToTransaction(input, { intervalMs, timeoutMs, signal })` | Async iterator; yields on state changes and stops when final |
| `checkIntent({ contractId, payerId, intentId })` | What a Sentinel Guard recorded: `PAID / PENDING / NOT_RECORDED / CONFLICTING / UNKNOWN` |
| `checkSpendAllowance({ contractId, ownerId, agentId })` | A Sentinel Vault allowance: `ACTIVE / EXHAUSTED / FROZEN / NO_POLICY / UNKNOWN`, the limits, and `availableNow` (the smallest any provider reports) |
| `exportDiagnosticReport(inspection)` | JSON report, schema `near-sentinel/diagnostic-report@1` |
| `read(method, params)` | Read with failover (transport and missing-history errors only) |

Standalone exports:
- `decideRetry` (the pure decision function)
- `diagnoseSubmissionError`
- `buildReceiptTree`, `classifyFound`, `outcomeDigest`
- `decodeSignedTx`
- `isValidAccountId`, `isValidCryptoHash`
- `assertPublicRpcUrl`, `createGuardedFetch`
- `rpcCall`

The testing toolkit lives at `@near-sentinel/sdk/testing`: `startMockRpc`, `startFaultProxy`.

## Errors

| Error | When |
|---|---|
| `SentinelInputError` | Invalid input. Nothing is sent to the network. |
| `SentinelUrlRejectedError` | A URL failed the SSRF policy. |

Network failures are **not** thrown. They become observations and diagnostics (timeouts, rate limits and so on), because a failure is evidence.

## Compatibility

- Declared `engines: node >= 20.19`; **tested on Node 22.16.0 and 22.23.4**. ESM package; `require()` works where Node supports `require(esm)` (verified on 22.16).
- Talks to nearcore JSON-RPC. Verified against testnet nearcore 2.14 on 2026-11-09.

## Tests

```bash
pnpm test        # 160 unit tests (mock RPCs, real fixtures)
pnpm test:live   # 10 read-only tests against public testnet and mainnet RPCs
```
