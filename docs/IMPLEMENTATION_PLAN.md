# Plan: NEAR Sentinel Guard (NEAR HACKATHON submission)

> **Historical planning document (2026-11-09), kept for the record.** The shipped design is described in the [README](../README.md) and [ARCHITECTURE](architecture/ARCHITECTURE.md); where this plan differs (for example the SDK build tool), the shipped code wins.

## Context

- **Hackathon:** NEAR HACKATHON. Submissions close **2026-11-14 23:59 UTC**.
- **Track:** "AI Security & Defense". Agent Economy and Open Innovation are optional extra tracks.
- **Problem:** an AI agent sends NEAR funds and the RPC call times out. The agent cannot tell whether the transfer landed. A typical agent then signs a new transaction, and the funds move twice.
- **Product:** Sentinel answers "is it safe to retry?" with evidence from several independent RPC providers. Verdicts: `DO_NOT_RETRY` / `WAIT_AND_RECHECK` / `SAFE_TO_RETRY` / `MANUAL_REVIEW_REQUIRED`. It also explains failures from the receipt tree.
- **Delivery channels:** an SDK, an MCP server for agents, a REST API and a dashboard. A demo on real testnet shows an unguarded agent paying twice and a guarded agent paying once.
- **The product is read-only.** It never signs or submits. Only the demo script signs, with the user's own testnet key, read from a local git-ignored `.env`.

**Decisions (2026-11-09):**
- Idea A.
- **SQLite** (Node's built-in `node:sqlite`) for history.
- **Real testnet** demo: the person running it creates their own sender and receiver accounts.

## Verified facts this plan relies on (checked 2026-11-09, read-only)

| Fact | Evidence |
|---|---|
| The drafted SDK type-checks | `tsc --noEmit` exit 0. 10/10 outcome tests pass on real fixtures. |
| Unknown tx + `wait_until: FINAL` returns HTTP 408 `TIMEOUT_ERROR`, `cause.info.cause = "NOT_OBSERVED"` (FastNEAR 10.3 s, near.org 13.3 s). Two earlier probes got **no response** within 20–30 s. | Live curl |
| dRPC testnet: `tx` works; `tx_status` returns `-32601 "method is not available"`; long waits return HTTP 408 code 30 at about 2 s | Live curl |
| `wait_until: NONE` answers immediately (found, or `UNKNOWN_TRANSACTION`) | Live curl |
| `transaction_validity_period` = 86,400 blocks. Testnet block time ≈ **0.58 s**, so the window is about **14 h** (not a day) | `EXPERIMENTAL_protocol_config`, block timestamps |
| Non-archival nodes return `UNKNOWN_BLOCK` for block 100M; archival nodes serve it. The near.org archival `status` misreports `earliest_block_height`. | Live curl |
| `view_access_key` returns `{nonce, block_height}` at finality=final | Live curl |
| near-api-js 7.4.0 retries every JSON-RPC call (including `send_tx`) up to 12× on HTTP 408/500/503, re-sending the same signed bytes. It exports `decodeSignedTransaction`, `encodeTransaction`, `createTransaction`, `KeyPairSigner.fromSecretKey`, and `Account(accountId, provider, signer)`. | Package source and `.d.ts` |
| MCP **v2** is current: `@modelcontextprotocol/server@2.4.0` (Node ≥ 20, zod ^4.2). API: `new McpServer({name,version})`, `registerTool(name, {description, inputSchema: z.object(...)}, handler)`, `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`. | npm and official v2 docs |
| Minimum supported Node is **22.16.0**. `tsup@9` needs ≥ 22.18 and `undici@8` needs ≥ 22.19, so **pin `tsup@8.5.1` and `undici@7.30.2`** (in the end the SDK is built with plain `tsc`, ESM only). vite 8, vitest 5 and plugin-react 6 need ≥ 22.12, which is OK. | `npm view engines` |
| `node:sqlite` works on 22.16 (prints an experimental warning). | Local check |
| Closest competitor, `near-transaction-investigator` v0.5: HTML prototype, single tx lookup, receipt-failure explanation. No retry verdict, no multi-provider proof, no agent/MCP. | GitHub README |
| Rules: public repo; an X post with video or screenshots; the README must list libraries and AI-generated code; a local-only demo is OK; first screening checks "it runs and does what the README says". | nearhackathon.com, HACKATHON.md |

**Corrections to earlier statements:**
1. An earlier draft of `docs/VERDICT.md` said the research audit was wrong about dRPC. The audit was right: `tx_status` is unsupported on dRPC; the earlier test had used `tx` instead.
2. The claim that timeouts "hang" is only partly true. Usually a structured 408 `NOT_OBSERVED` comes back. Both cases must be handled.
3. "Validity about a day" is wrong. It is about 14 h on testnet.

## Architecture (pnpm monorepo, already scaffolded)

```
packages/sdk     @near-sentinel/sdk      core engine (exists, drafted)
packages/mcp     @near-sentinel/mcp      MCP stdio server (v2 SDK)
apps/api         @near-sentinel/api      Fastify 5 REST API + SQLite + background prober, also serves built web
apps/web         @near-sentinel/web      Vite 8 + React 19 + Tailwind 4 + TanStack Query dashboard
examples/agent-demo                      naive vs guarded agent (real testnet), plus a simulated mode
docs/                                    STATUS, VERDICT, research, architecture, API, security, limitations
```

**Not building** (already exists, or too much for 5 days):
- A full explorer: link out to `testnet.nearblocks.io/txns/<hash>`.
- An up/down status page.
- Postgres, Redis or OpenTelemetry.
- Billing, or API-key management UI. API keys come from env.

**Why a hand-written RPC transport instead of `@near-js/jsonrpc-client`:** we need one raw observation per call (timing, HTTP status, a byte cap, and no hidden retries). The official client retries 3× internally, which would hide the evidence. Documented in the architecture doc.

## Work plan

### Step 0: housekeeping (start)
- `git init` locally. Commits only with the owner's approval.
- Pin versions in `packages/sdk/package.json`: `undici@7.30.2` (`tsup` was later dropped for plain `tsc`). Re-run `pnpm install`.
- Correct `docs/VERDICT.md`: the dRPC claim, the timeout nuance, and the 14 h validity window.

### Step 1: finish and harden the SDK (`packages/sdk/src`)
Fixes to the drafted code:
- **`testing.ts`:** rewrite the mock-server fault branch so a delay can be followed by a scripted answer. Handler return shape: `{result|error, delayMs?} | {fault}`.
- **`sentinel.ts`:**
  - Add a `tx_status` capability probe (stable name) alongside `tx` and `EXPERIMENTAL_tx_status`.
  - Replace the hard-coded `blockTimeSeconds: 1` with a measured average, cached for 10 min.
  - Only report `HISTORY_NOT_COVERED` when phase 2 actually ran.
- **`diagnostics.ts` / `rpc.ts`:** surface the `TIMEOUT_ERROR` `cause` (`NOT_OBSERVED` / `PENDING` / `ERROR`) in the explanation and evidence:
  - `NOT_OBSERVED` from a node means "this node has not seen the tx".
  - `PENDING` means "seen, not yet executed".
- **`retry.ts`:** unchanged logic. Covered by the new tests below.

New tests (vitest; every test asserts verdicts and evidence, none are skipped):
- `retry.test.ts`, the decision table:
  - found (success / failure / partial / included / conflicting)
  - not found without a nonce
  - nonce consumed with 2 operators → SAFE
  - nonce consumed with 1 operator → MANUAL
  - same operator on 2 hostnames → not independent
  - missing key → MANUAL, never SAFE
  - expired → SAFE
  - still valid → WAIT
  - all providers erroring → WAIT, low confidence
- `transport.test.ts`, using the mock RPC: timeout, HTTP 408 code 30, 429, reset, malformed JSON, oversized body (capped), 502 HTML, the discontinued-endpoint JSON, caller abort.
- `sentinel.test.ts`, using mock RPCs as several providers:
  - phase ordering: the access key is read before the second tx lookup (asserted via the request log)
  - a lagging provider → `CONSISTENT_WITH_LAG`
  - conflicting digests → `CONFLICTING` + MANUAL
  - a stale provider (fault `stale-unknown-tx`) does not flip a found tx to unknown
  - the signed-tx path derives the hash
- `ssrf.test.ts`:
  - rejects localhost, 127.0.0.1, 10/8, 169.254.169.254, [::1], `::ffff:127.0.0.1`, decimal/hex IPs, `http:`, credentials in the URL, bad ports
  - accepts a public https host
  - the guarded fetch blocks a hostname that resolves to loopback at connect time
- `diagnostics.test.ts`: submission-error shapes:
  - real `TIMEOUT_ERROR` JSON, dRPC code 30
  - `InvalidNonce`, `NotEnoughBalance`, `Expired`, `ShardCongested`
  - near-api-js error strings, unknown input
- `live.test.ts`: real testnet, run separately with `pnpm test:live`:
  - inspect the fixture hashes on all providers and expect them found and unanimous
  - an unknown hash → `UNKNOWN` + WAIT
  - a provider health check returns capabilities, with dRPC `supportsTxStatus = false`

Build: plain `tsc` (ESM + d.ts; originally planned as `tsup` ESM + CJS). Verify by importing the built `dist` from a plain Node script.

### Step 2: MCP server (`packages/mcp`)
- `@modelcontextprotocol/server@2.4.0` + zod 4. Stdio transport.
- Tools: `check_retry_safety`, `inspect_transaction`, `diagnose_submission_error`, `provider_health`, `trace_receipts`. Each returns a short text verdict plus JSON structured content.
- Config via env: `NEAR_SENTINEL_NETWORK`, and optionally `NEAR_SENTINEL_RPC_URLS`. The read-only rule is stated in the tool descriptions.
- **Verify:** a script spawns the server and calls each tool through the official client (`@modelcontextprotocol/client`, also v2; version to be checked at install). Then register it in Claude Code with `claude mcp add` (with the owner's approval) and call it live.

### Step 3: REST API (`apps/api`, Fastify 5)
- **Endpoints** (master-prompt list, all backed by the SDK):
  - `GET /health`, `GET /ready`
  - `GET /api/v1/providers`, `/providers/health`, `/providers/metrics`
  - `POST /api/v1/providers`: register a custom RPC. API key required, SSRF-guarded, and confirmed to be NEAR testnet or mainnet via `status.chain_id`.
  - `POST /api/v1/transactions/inspect`, `GET /api/v1/transactions/:hash?sender=`, `/:hash/receipts`, `/:hash/diagnostics`
  - `POST /api/v1/transactions/retry-check`
  - `POST /api/v1/diagnose/error`
  - `GET /api/v1/benchmarks`, `POST /api/v1/benchmarks/run` (API key)
  - `GET /api/v1/reports/:id`, `GET /api/v1/incidents`
  - `GET /api/v1/events`: SSE stream of provider health
  - Prometheus metrics on a separate listener bound to `127.0.0.1:9464` by default
- **Cross-cutting concerns:**
  - zod validation and a consistent error envelope `{error:{code,message,requestId}}`
  - `x-request-id`
  - `@fastify/rate-limit`, with a configurable quota
  - API-key auth (keys hashed in env; constant-time compare)
  - CORS allow-list
  - OpenAPI docs via `@fastify/swagger` + `swagger-ui` at `/docs`
  - pino logs that redact headers and keys
  - graceful shutdown
  - env validation at boot
- **SQLite** (`node:sqlite`, file `data/sentinel.db`), with a migrations table. Tables:
  - `provider_samples` (periodic health and latency)
  - `incidents` (provider down / recovered / capability change / lag, opened and closed automatically)
  - `reports` (saved inspection JSON)
  - `benchmark_runs` (each tagged `real` or `simulated`)
  - `audit_log` (protected operations)
- **Background prober:** every 30 s for health, every 10 min for capabilities. Respects near.org's 30 req/min limit.
- **Benchmarks:**
  - "real" runs measure latency percentiles, answer rate and agreement on known fixture hashes.
  - "simulated" runs drive the fault proxy and check that each fault gets the expected classification.
  - Results are stored separately and labelled. No score is shown below `MIN_SAMPLE=30`.
- **Tests:** API tests with `fastify.inject` against mock providers (validation, auth, rate limit, error format, SSRF registration rejection, a duplicate retry-check returning the same verdict).

### Step 4: dashboard (`apps/web`)
- Dark, dense, developer UI. Every status shows its source provider and last-updated time. Clear loading, empty and error states. **No mock data** except an explicitly labelled demo mode.
- **Pages:**
  1. Overview: network, provider count, open incidents, recent inspections
  2. Providers: health table, capability matrix, latency p50/p95, lag
  3. Inspect: hash + sender, or a signed tx → state, retry verdict with checks, diagnostics with evidence, a collapsible receipt tree with failures highlighted, JSON export, link to NearBlocks
  4. Benchmarks: real vs simulated, kept separate
  5. Incidents
  6. Integrate: SDK, MCP and API snippets
  7. Settings: read-only view of the config
- The API serves the built web app, so one command runs everything. `pnpm dev:api` and `pnpm dev:web` run them separately, with a Vite proxy.
- **Verify:** drive it in Chrome via claude-in-chrome against the real API on testnet. Screenshots go into the README.

### Step 5: demo (`examples/agent-demo`). Needs the user's own testnet accounts.
- Uses `.env`, which the user fills in and which is git-ignored: `DEMO_SENDER_ACCOUNT_ID`, `DEMO_SENDER_PRIVATE_KEY`, `DEMO_RECEIVER_ACCOUNT_ID`.
- Flow:
  1. Read balances.
  2. Sign a 0.01 NEAR transfer.
  3. Send `send_tx` through the fault proxy in `forward-then-hang` mode, so the tx reaches the chain but the client times out.
  4. **Naive agent:** catches the timeout, re-signs with a new nonce, and sends again. Result: 2 transfers.
  5. **Guarded agent:** calls `checkRetrySafety(signedTx)`. Gets `WAIT_AND_RECHECK` and then `DO_NOT_RETRY`. Result: 1 transfer.
  6. Print before/after balances and NearBlocks links.
- Also a `--simulated` mode against the mock RPC (no wallet), so anyone can reproduce it.
- Plus a scripted Claude Code session using the MCP tool, for the video.
- **The exact transfers (amount, from, to, chain) are stated and approved by the owner before the first real run.**

### Step 6: docs, Docker, submission prep
- **Docs:**
  - README: what it is, quick start, architecture diagram, an SDK/MCP/API usage table, demo steps, limitations, and a **libraries + AI-generated-code disclosure** as the rules require
  - CONTRIBUTING, SECURITY, LICENSE (MIT), CHANGELOG, `.env.example`
  - `docs/architecture/STATE_MAPPING.md` (RPC → state table)
  - `docs/api/` (link to OpenAPI)
  - `docs/security/THREAT_MODEL.md`
  - `docs/deployment/DEPLOY.md` (VPS + Docker, SQLite backup with `VACUUM INTO`)
  - `docs/KNOWN_LIMITATIONS.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROGRESS.md`
  - Rename `COMPETITOR_RESEARCH_RAW.md` to `docs/COMPETITOR_RESEARCH.md`, adding corrections
- **Docker:**
  - A multi-stage `Dockerfile` (non-root, healthcheck).
  - `docker-compose.yml` with an API+web service and a SQLite volume. No DB port, and metrics are not exposed publicly.
  - Verify with `docker compose up` and a curl health check.
- `pnpm audit` for dependency scanning, with results recorded.
- Draft the submission description and X-post text **for the owner to post**. The agent never posts or submits.

## Schedule (UTC)

| Date | Work |
|---|---|
| Nov 9–10 | Steps 0–1 |
| Nov 10–11 | Steps 2–3 |
| Nov 11–12 | Step 4 |
| Nov 12–13 | Step 5 (needs the owner's testnet accounts by Nov 12) and Step 6 |
| Nov 14 | Buffer, final audit. You record the video, push the repo and submit before 23:59 UTC. |

`docs/STATUS.md` is updated after every step.

## Verification (end to end; nothing is claimed unless it was run)

1. `pnpm -r typecheck`, `pnpm test` (unit + API), `pnpm test:live` (testnet). All output is recorded in STATUS.
2. `pnpm build`, then `pnpm start`. Then:
   - `curl /health`, `/api/v1/providers/health` (real testnet data)
   - `POST /transactions/inspect` with the fixture hashes, giving the expected states (success / failure / partial)
   - `retry-check` with an unknown hash, giving WAIT
3. MCP: a client script calls every tool. Then a live call from Claude Code.
4. Dashboard: a browser walk-through of every page with real data; screenshots.
5. Simulated demo: run with no wallet. Expected: naive = 2 sends, guarded = 1.
6. Real testnet demo (after the owner's OK): balances and NearBlocks links show 2 vs 1 transfers.
7. `docker compose up --build`, then a health check, then teardown.
8. A final audit against the master prompt's Definition of Done. Anything not met goes in KNOWN_LIMITATIONS, not the README.

## Needed from the owner (later; no blocker for Steps 0–4)
- **By Nov 12:** two testnet accounts (sender, receiver). The owner puts the sender key in `examples/agent-demo/.env` directly; keys are never shared.
- **Before submission:**
  - the GitHub repo
  - approval for each commit and push
  - the mainnet payout account (entered in the form by the owner)
  - recording and posting the X demo
