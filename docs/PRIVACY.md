# Privacy

NEAR Sentinel is a read-only tool. It needs no account, sets no cookies and never handles keys. This page lists everything it keeps, for how long, and why.

## What the API stores

The API keeps a single SQLite file (`DATA_DIR/sentinel.db`). Source: `apps/api/src/db.ts`.

| Table | What is in it | Kept for |
|---|---|---|
| `provider_samples` | RPC provider health probes: provider name, latency, block height, error kind | 7 days |
| `reports` | Saved inspection reports: transaction hash, verdict, state, evidence. All of it is public chain data. | 30 days |
| `audit_log` | Protected actions (add/remove provider, start benchmark, rejected API-key attempts): time, request id, action, outcome, and a **hashed** client IP | 30 days |
| `incidents` | Provider outages and lag detected by the prober | Until removed by the operator |
| `custom_providers` | RPC endpoints an operator added with an API key | Until removed |
| `benchmark_runs` | Benchmark parameters and results | Until removed by the operator |

Retention is enforced by `prune()`, which runs at start-up and then every hour on its own timer (also when the prober is disabled).

**Hashed IPs.** The audit log never stores a raw IP. It stores `h:` plus the first 16 hex characters of HMAC-SHA256(salt, ip). By default the salt is random and new on every start, so hashes cannot be linked across restarts. An operator who needs to link them (for abuse investigation) can set `AUDIT_IP_SALT` (16+ characters). Raw IPs written by older versions are converted to hashes when the database is opened. This is pseudonymisation, not anonymisation: whoever holds the salt can test a known IP against a hash.

**Rate limiting** keys on the client IP, held in memory only. It is gone when the process restarts. The same applies to the per-client event-stream counter and to the single-use account-verification nonces (5-minute expiry).

**Request logs.** The API's per-request log lines carry only a request id, method and URL (no client address or port). The reverse proxy (`deploy/vultr/Caddyfile`) deletes the client IP, port, `X-Forwarded-For`, cookies and authorization from both its access log and the request details in its own error log. One honest exception: a rare low-level error line from the proxy (for example a failed TLS handshake) can still name the peer address in its message text. Authorization headers, API keys and cookies are also redacted from the API's logs. Log retention is set by the host (Docker log rotation); set `LOG_LEVEL=warn` to stop per-request lines entirely.

## What Sentinel never stores

- **Private keys or seed phrases.** Sentinel never asks for them. The repository's secrets gate (`scripts/check-secrets.mjs`, first step of `pnpm test`) fails if one is ever committed.
- **Wallet sessions.** In the dashboard, wallet connection uses NEAR Connect (`apps/web/src/wallet.ts`). Every signature happens inside the user's own wallet; the dashboard only receives the result.
- **Accounts or profiles.** There is no sign-up. Optional account verification (NEP-413) proves ownership once and creates no session.

## The web dashboard

- **No cookies.**
- **No analytics, trackers or third-party scripts.**
- **Browser storage**, on your device only:

| Key | Storage | Holds |
|---|---|---|
| `sentinel.tour` | localStorage | Which steps of the Start tour you have done |
| `sentinel.identity` | localStorage | Your verified account result, or that you skipped verification |
| `sentinel.identity.pending` | sessionStorage | Nonce for a verification in progress; removed when the wallet returns |

Clearing site data in your browser removes all of it.

## On-chain data is public forever

Anything sent to the Guard or Vault contracts (account names, amounts, receivers, **intent / payment IDs**) is written to the NEAR blockchain. Anyone can read it and it cannot be deleted. Do not put emails, phone numbers, order numbers or customer names in an intent ID. Use the SDK's `privateIntentId(secret, reference)`, which derives a stable, non-reversible ID from your own reference, so you can still look the payment up later without revealing the reference.

## Full control: self-host

The SDK and MCP server run on your own machine and talk directly to the RPC providers you choose; they send nothing to a Sentinel server. To run the API and dashboard yourself:

```bash
docker compose up -d --build     # http://127.0.0.1:8080, data in the `sentinel-data` volume
```

You then own the database, the logs and the retention. See [deployment/DEPLOY.md](deployment/DEPLOY.md).

## Questions

See [SECURITY.md](../SECURITY.md) for how to report a problem.
