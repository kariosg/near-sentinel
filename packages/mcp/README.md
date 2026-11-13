# @near-sentinel/mcp

A stdio MCP server that lets AI agents ask **"is it safe to retry this NEAR transaction?"** before they sign anything new. Every tool is read-only.

```bash
pnpm build   # from the repo root
claude mcp add near-sentinel -e NEAR_SENTINEL_NETWORK=testnet -- node /abs/path/to/near-sentinel/packages/mcp/dist/server.js
```

| Tool | Input | Output |
|---|---|---|
| `check_retry_safety` | `signedTransactionBase64` (preferred) **or** `transactionHash` + `senderAccountId`; `includeRawEvidence?` | `VERDICT: …` text + full structured result |
| `inspect_transaction` | same | state, finality, diagnostics, provider agreement |
| `trace_receipts` | same | receipt tree (✓ / ✗ / …) |
| `diagnose_submission_error` | `error` (raw JSON or message) | classification; no network |
| `provider_health` | — | per-provider liveness, lag, tested capabilities |
| `check_intent` | `contractId`, `payerId`, `intentId` | `PAID` / `PENDING` / `NOT_RECORDED` / `CONFLICTING` / `UNKNOWN` for a Sentinel Guard intent, with per-provider evidence |
| `preflight_spend` | `contractId`, `ownerId`, `agentId`, `receiverId`, `amountYocto`, `intentId?` | `ALLOWED` / `BLOCKED` (code: `NOT_ALLOWED_RECEIVER`, `OVER_PER_PAYMENT_LIMIT`, `OVER_DAILY_LIMIT`, `INSUFFICIENT_VAULT_BALANCE`, `DUPLICATE_INTENT`, `FROZEN`, `NO_POLICY`, …) / `UNKNOWN`: the Vault's own checks before signing (advisory), plus `action` `SIGN` / `ASK_HUMAN` / `REFUSE`, which also folds in the receiver check. Agents act on `action` |
| `check_receiver` | `receiverId`, `knownReceivers?` | `OK` / `WARNING` / `DANGER` (lookalike of a known payee, address poisoning) / `NOT_FOUND` / `UNKNOWN`, with the technique and a side-by-side reason. Call before paying anyone new |
| `audit_agent_keys` | `accountId`, `vaultContractId?` | `FULL_ACCESS_PRESENT` / `REVIEW_NEEDED` / `LEAST_PRIVILEGE` / `NO_KEYS` / `ACCOUNT_NOT_FOUND` / `UNKNOWN`, each key graded, near-cli-rs setup commands |
| `check_spend_allowance` | `contractId`, `ownerId`, `agentId` | `ACTIVE` / `EXHAUSTED` / `FROZEN` / `NO_POLICY` / `UNKNOWN` for a Sentinel Vault allowance, the limits, and `availableNow` (the smallest any provider reports), with per-provider evidence |

## Environment

| Variable | Default | |
|---|---|---|
| `NEAR_SENTINEL_NETWORK` | `testnet` | or `mainnet` |
| `NEAR_SENTINEL_RPC_URLS` | — | `name=url\|operator,…` replaces the default providers (SSRF-checked) |
| `NEAR_SENTINEL_MIN_OPERATORS` | `2` | independent operators required for `SAFE_TO_RETRY` |
| `NEAR_SENTINEL_TIMEOUT_MS` | `10000` | per request |
| `NEAR_SENTINEL_ALLOW_PRIVATE` | — | `1` allows localhost RPCs (local demos only) |

`pnpm test` builds the server and drives it over stdio with the official MCP client (17 tests, 10 tools).
