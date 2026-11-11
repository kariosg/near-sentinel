# Changelog

## 0.1.0 (2026-11-10)

First release, built for NEAR HACKATHON (Nov 2026).

### Sentinel Vault (2026-11-11)
- New contract `contracts/guard/vault` (crate `sentinel-vault`): an owner-funded allowance for an AI agent with a per-payment limit, a rolling 24-hour limit, a receiver allowlist, freeze and owner-only withdraw. The agent calls `spend` with no deposit, so it can hold only a function-call key limited to `spend`. Pay-once per (owner, agent, intent); a failed transfer restores the balance and allowance.
- 19 Rust unit tests; 14 sandbox checks, including a function-call key that pays within the policy and is rejected by NEAR for a direct transfer or any other method (sandbox total 27/27 with the guard).
- Live on testnet as `vault.karios.testnet` (code hash matches the build), live suite 10/10, and a demo allowance for the dashboard. `pnpm vault:testnet` reproduces it with the payer's existing key.
- Read-only support everywhere: SDK `checkSpendAllowance`, MCP `check_spend_allowance` (7 tools), API `GET /api/v1/allowance`, dashboard "Agent allowance" panel; the smallest available amount any provider reports wins.
- `pnpm verify` (one summary table of every check) and `JUDGING.md` (each claim with its proof).

### NEAR AI agent and NEAR Connect (2026-11-12)
- Read-only **mainnet** checks in `pnpm test:live` (3 tests): mainnet providers, a real recent mainnet transaction picked live → DO_NOT_RETRY, an unknown hash → WAIT_AND_RECHECK. Live suite now 10 (7 testnet + 3 mainnet).
- Dashboard: Vault owner actions through **NEAR Connect** (`@hot-labs/near-connect` 0.12.0, which replaced the deprecated Wallet Selector): fund/update a policy, freeze/unfreeze, withdraw, each with a preview of exactly what the wallet will sign. Loaded lazily; the server stays keyless.
- `examples/near-ai-agent`: a payments agent on NEAR AI Cloud (OpenAI-compatible API, model NEAR AI hosts in a TEE) with NEAR Sentinel as its tools. Sentinel's verdict is binding: a deterministic guard overrules a model that proposes paying again after Sentinel said the payment executed, and escalates when no evidence was gathered. Live run `pnpm demo:near-ai` records each answer's NEAR AI response signature and the model's attestation report in `docs/near-ai-run.md`; 7 offline tests run against a mock of the API (no key needed). `pnpm verify` reports the live run as SKIPPED without a key.
- README leads with the problem in one sentence and the real-money proof, and explains what NEAR makes possible (provable non-execution, receipts, function-call keys, named accounts, NEAR AI).

### Safety fixes from an independent review (2026-11-11)
- **Re-check keeps positive evidence:** if the delayed re-lookup finds the transaction at any provider while lagging ones still say "not found", the found evidence now drives the verdict (DO_NOT_RETRY / WAIT), never SAFE_TO_RETRY. Regression test proves the old code returned SAFE here.
- **Vault, daily limit at the 24-hour boundary:** a failed transfer now gives allowance back only to the window it was counted in, so spends around the reset cannot exceed `daily_max`.
- **Vault, storage fee:** the per-spend record fee is 0.006 NEAR, covering the measured worst case (591 bytes with 64-character accounts and intent id); previously 0.003 NEAR could fall short.
- The live vault was upgraded in place (code only, state kept): tx `5o2YyZWQwEWyJVimMGer3AXMVqydvWcNztkhDGWXf1ne`, code hash `7u8KGfkdn4gJCuTBNeqwMfVB2pDR8w2PvXxthMvQuLp9`; live suite 10/10 again with a fresh agent account.
- **Default providers:** `rpc.{testnet,mainnet}.near.org` turned out to be a CNAME to FastNEAR's infrastructure, so it was a second FastNEAR witness, not an independent operator. Replaced by Intear's RPC (its own nodes; ~1 s slower without an API key, but no tight rate limit; Tatum's free gateway was tried and rejected at 5 requests/minute). Defaults are now FastNEAR, dRPC and Intear: 3 truly independent operators. A regression test enforces that no FastNEAR alias is ever counted as another operator.
- **Load-balanced endpoints:** a "nonce consumed + not found" answer now only counts as proof after a delayed re-lookup (default 2.5 s, `proofRecheckMs`) still finds nothing. A lagging backend in a provider pool can no longer turn an executed transaction into SAFE_TO_RETRY; it falls back to WAIT_AND_RECHECK.
- **Guard contract:** new sandbox check (13/13) confirms a failed payment larger than the contract's own balance is still refunded in full and released.

### Sentinel Guard on testnet (2026-11-11)
- Deployed as `guard.karios.testnet` (code hash matches the local build); live suite 11/11 on testnet.
- `pnpm contract:create-account`: creates the contract sub-account with the payer's existing key (no key generation); `deploy` reuses it.
- Dashboard Guard panel: one-click live examples (paid and unused intent) against the testnet deployment.
- `pnpm demo:critical`: real-testnet check of the critical verdicts with freshly signed transactions (5/5); the real-testnet demo ran (naive 2×, guarded 1×). Both reuse the Guard payer key from `contracts/guard/.env` when the demo key is empty.
- Live deployment at https://64-177-60-105.sslip.io (Vultr 1 GB, Caddy + Let's Encrypt via a free sslip.io name). The Caddy setup no longer needs an ACME email, so no personal address is sent anywhere. VULTR.md documents the build-locally, copy-the-image path for small servers.
- API sends anti-framing headers (`X-Frame-Options: DENY`, `frame-ancestors 'none'`) itself, so direct deployments without a reverse proxy are protected from clickjacking.

### SDK (`@near-sentinel/sdk`)
- Multi-provider transaction inspection with per-call evidence, answer validation and provider agreement.
- Retry-safety verdicts. Unseen transactions can only be marked `SAFE_TO_RETRY` with per-node proof (nonce or expiry, window coverage, not found) from ≥ 2 independent operators.
- A found failure is only `SAFE_TO_RETRY` when the same failed outcome is `FINAL` on ≥ 2 independent operators. Expiry uses each provider's own hash-verified block height.
- Receipt tree, state classification and masked-downstream-failure detection.
- Diagnostics for nearcore `TIMEOUT_ERROR` causes, `InvalidTxError` variants and dRPC shapes.
- Tested provider capabilities (archival, `tx_status` support).
- SSRF-guarded fetch with connect-time IP checks.
- Fault-injection proxy and mock RPC.
- `checkIntent`: read-only lookup of a Sentinel Guard intent across providers (positive evidence wins; disagreement surfaced; records for another payer/intent rejected).

### Guard contract (`contracts/guard`, new)
- `pay(intent_id, receiver_id)`: forwards a payment at most once per (payer, intent). Duplicates panic `DUPLICATE_INTENT` (deposit refunded); failed transfers release the intent and refund in full. No owner/admin/upgrade.
- Docker build (Rust 1.86, `--cfg near`), 14 unit tests, 12-check on-chain suite on a local neard 2.14 sandbox, dry-run-first testnet deploy and live-test scripts.

### MCP (`@near-sentinel/mcp`)
- Six read-only tools over stdio (`@modelcontextprotocol/server` 2.4.0), including `check_intent` for Sentinel Guard intents.

### API (`@near-sentinel/api`)
- `GET /api/v1/intents`, optional NEP-413 account verification (`/api/v1/identity/challenge`, `/verify`), `GUARD_CONTRACT_ID`.
- Static assets are no longer rate-limited; event streams capped per IP; SSE headers flushed on connect.
- Fastify 5 REST API with OpenAPI.
- SQLite history: background prober with debounced incidents.
- Real and simulated benchmarks, kept separate. The simulated one (local mocks only) is public and rate-limited; the real one needs an API key.
- API-key auth (digests, fail closed) with an audit log. Rate limits, SSE, Prometheus on localhost.
- Docker image with graceful SIGTERM.

### Dashboard
- Redesign: a dark "security console" look, a **Start here** landing page (animated architecture diagram, naive-vs-guarded comparison, a 5-step judge tour with saved progress, verdict guide, terminal commands), grouped sidebar with icons, mobile menu drawer, Ctrl+K command palette, toasts, count-up stats, progress rings, an animated verdict card and provider-query progress. All motion respects the OS reduce-motion setting.
- Guard-contract lookup panel; optional, skippable "Verify your NEAR account" with a note for judges.
- WCAG 2.1 AA fixes found by axe (contrast of red text and primary buttons, underlined inline links); tables scroll inside cards on mobile.
- Placeholders styled as hints (dim, italic, "e.g.") so empty fields never look filled in; judges can run the 12-scenario fault benchmark with one click.
- Eight pages on real data, a receipt graph and a validated-palette latency chart.

### Deployment
- Vultr production setup (`deploy/vultr`): Docker Compose with Caddy (automatic HTTPS, SSE-friendly), a read-only container with the app not exposed directly, server setup, deploy/update/rollback and backup scripts, and a step-by-step guide in [docs/deployment/VULTR.md](docs/deployment/VULTR.md).

### Demo
- Naive vs guarded agent: simulated (asserted) and real-testnet (gated) modes.
