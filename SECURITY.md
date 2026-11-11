# Security policy

## Model

NEAR Sentinel is **read-only**:
- It never asks for, receives, stores or logs private keys or seed phrases.
- It never signs or submits transactions. A `signedTransactionBase64` input carries a *signature*, not a key, and is only decoded to read the hash, nonce, public key and block hash.
- `compareProviders` accepts only an allow-list of read methods. `send_tx` and `broadcast_tx_*` are rejected (tested).

The only code in this repository that signs anything is:
- `examples/agent-demo` (the real-testnet demo), and
- `contracts/guard/scripts` (deploy + live test of the guard contract, and the local sandbox suite).

They sign with keys the operator places in **git-ignored** `.env` files (`examples/agent-demo/.env`, `contracts/guard/.env`). Every script refuses to run unless the RPC reports `chain_id=testnet` (or `sandbox` for the local suite), defaults to a dry run, needs `--i-confirm` to send anything, and never prints a key. The API's own `.env` (loaded into the Docker container) must never hold keys.

**Secrets gate:** `pnpm test` starts with `scripts/check-secrets.mjs`, which fails if any file git would commit contains a NEAR secret key, a seed-phrase-like word list, or a `.env` file. It prints only file and line, never the match.

**Guard contract:** no owner, no admin methods, no upgrade path. The callback is `#[private]` (verified on-chain). See [contracts/guard/README.md](contracts/guard/README.md).

**Optional account verification (NEP-413):** server-issued 32-byte nonces, single use, 5-minute expiry, burned on the first attempt; recipient and message bound; ed25519 verified server-side; the key must be a FullAccess key of the account on-chain. It creates no session and grants no rights.

**Safety of verdicts:** "unknown" is never converted into "safe". `SAFE_TO_RETRY` for an unseen transaction requires independent proof from ≥ 2 operators (see [docs/architecture/STATE_MAPPING.md](docs/architecture/STATE_MAPPING.md)).

## Controls implemented (and where they are tested)

| Control | Where | Test |
|---|---|---|
| SSRF guard: https only, no credentials in URLs, port allow-list, blocks private / loopback / link-local / metadata / CGNAT / IPv4-mapped / decimal-hex IPs and internal hostnames | `packages/sdk/src/ssrf.ts` | `ssrf.test.ts`, API SSRF test |
| DNS-rebinding defence: the IP is re-validated at **connect time** | `createGuardedFetch` | `ssrf.test.ts` (hostname → loopback blocked; reason asserted) |
| Redirects refused | `rpc.ts` (`redirect: "error"`) | — |
| Response size cap (default 8 MiB; streamed, aborts early) | `rpc.ts` | `transport.test.ts`, live test |
| Per-request timeouts and caller cancellation | `rpc.ts` | `transport.test.ts` |
| Untrusted provider answers rejected (wrong hash / malformed) | `sentinel.ts` `validateTxResult` | `sentinel.test.ts` |
| Custom providers must serve the configured chain | `POST /api/v1/providers` | API test (mainnet endpoint → 422) |
| Input validation (strict zod; unknown fields rejected) | `apps/api/src/app.ts`, `packages/sdk/src/validation.ts` | API tests |
| API keys stored as SHA-256 digests, constant-time compare, fail closed | `apps/api/src/auth.ts` | API tests |
| Audit log of protected operations (including failures) | `audit_log` table | API test |
| Rate limiting; `X-Forwarded-For` ignored unless `TRUST_PROXY=1` | Fastify rate-limit | API test (spoofing does not bypass) |
| Secrets redacted from logs (`authorization`, `x-api-key`, cookies) | pino redact | Verified: key appeared 0 times in a live log |
| SQL injection: prepared statements only | `apps/api/src` | code review |
| Metrics not exposed publicly (separate 127.0.0.1 listener; not published by Compose) | `metrics.ts`, `docker-compose.yml` | Verified in Docker |
| Container runs as non-root `node` | `Dockerfile` | Verified |
| Event streams capped per client IP (10) and in total (200) | `/api/v1/events` | API test |
| Request body limit 2.5 MB (413) | Fastify `bodyLimit` | API test |
| NEP-413 verification: forged / wrong-key / reused-nonce / unknown-nonce / wrong-recipient / FunctionCall-key all rejected | `apps/api/src/identity.ts` | API tests, E2E (forged wallet callback) |
| Guard contract: duplicate intent, private callback, input validation, concurrent race | `contracts/guard` | Rust unit tests + on-chain sandbox suite |
| No secrets in the repository | `scripts/check-secrets.mjs` | runs first in `pnpm test`; self-tested with planted fake key and seed line |
| Dependency scanning | `pnpm audit` | "No known vulnerabilities found" (2026-11-10) |

## Reporting a vulnerability

Please open a private security advisory on the repository, or contact the maintainer listed on the repository page. Do not open public issues for vulnerabilities. Include reproduction steps, affected version and impact.
