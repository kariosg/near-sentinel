# Changelog

## 0.1.0 (2026-11-10)

First release, built for NEAR HACKATHON (Nov 2026).

### Sentinel Guard on testnet (2026-11-11)
- Deployed as `guard.karios.testnet` (code hash matches the local build); live suite 11/11 on testnet.
- `pnpm contract:create-account`: creates the contract sub-account with the payer's existing key (no key generation); `deploy` reuses it.
- Dashboard Guard panel: one-click live examples (paid and unused intent) against the testnet deployment.

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
