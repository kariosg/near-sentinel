# NEAR Sentinel: competitor and ecosystem research

> **Verification notes (added 2026-11-10 after re-checking claims live and in source):**
> - Confirmed: dRPC testnet rejects `tx_status` (`-32601 "method is not available"`) but accepts `tx` and `EXPERIMENTAL_tx_status`. Sentinel's capability probe detects this automatically.
> - Confirmed: an unknown hash with `wait_until: FINAL` returns HTTP 408 `TIMEOUT_ERROR`, `cause NOT_OBSERVED` (FastNEAR 10.3 s, near.org 13.3 s). Two separate probes got no answer at all within 20–30 s.
> - Clarified: near-api-js re-sending a timed-out `send_tx` re-sends the **same signed bytes**. That is duplicate-safe on NEAR (same hash and nonce). The double-spend risk is an app or agent **signing new bytes** after a timeout. That is the gap Sentinel addresses.
> - Added: nearcore returns a missing access key from `view_access_key` as a *successful* result with `result.error: "… does not exist while viewing"`.
> - Testnet `transaction_validity_period` = 86,400 blocks; measured block time ≈ 0.58 s, so a signed tx stays includable for ≈ 14 h.

Research date: **2026-11-09**. Methods: WebSearch/WebFetch, read-only `gh search` / `gh api`, `npm view`, and live `curl` probes of public RPCs from a single client location. No GitHub writes were made.

Confidence tags: **[verified]** means I checked it directly (source code, live probe, or official page). **[source]** means a cited page says it. **[uncertain]** means inferred or only partly confirmed.

Caveat on GitHub search: `gh search repos` is keyword-AND and missed some quoted multi-word queries. I hit the search rate limit once and re-ran those queries. Absence claims below list the exact queries.

---

## 1. Existing products

| Name | URL | What it does | Status |
|---|---|---|---|
| NearBlocks | https://nearblocks.io / https://testnet.nearblocks.io | Main NEAR explorer and API. Tx pages have `execution`, `enhanced`, `tree` and `receipts` sub-routes (receipt tree / execution plan). The UI has a user-selectable, user-addable RPC provider. The backend has RPC failover with retry classification (`RpcFailover`, `isRetryableRpcFailure`, `isTransportTimeout`) on top of `@near-js/jsonrpc-client`. | Active. Repo pushed 2026-11-09. [verified via source: `apps/frontend/src/app/[lang]/txns/[tid]/{execution,enhanced,tree,receipts}`, `apps/frontend/src/components/rpc/index.tsx` (`RpcSelector`), `apps/backend/src/libs/rpcClients.ts`] |
| Pikespeak | https://pikespeak.ai | "NEAR Portfolio Tracker and Explorer" (page title). | Site live (HTTP 200). Feature depth not verified (page is JS-rendered). **[uncertain]** whether it has a receipt tree. |
| NEAR Rocks (FastNEAR explorer) | https://near.rocks (explorer.fastnear.com redirects here) | Explorer by FastNEAR, backed by `fastnear/explorer-api` (tx-hash batch lookup API over ClickHouse). | Active [verified redirect; repo pushed 2026-10-23]. Receipt-tree UI **[uncertain]**. |
| Nearscope | https://nearscope.net | Validator/staking explorer. | Live [verified HTTP 200]. |
| Explorer selector | https://explorer.near.org | The old NEAR Explorer was replaced by a selector page ("Near Explorer Selector"). `near/near-explorer` was archived (pushed 2024-02-19). | [verified] |
| **status.near.org** | https://status.near.org | **Official NEAR status page (Oh Dear).** It monitors mainnet and testnet RPC (fastnear.com, near.org, lavanet.xyz), archival RPC (near.org, fastnear.com), NearBlocks and its API, Pikespeak, MyNearWallet, neardata.xyz, BigQuery, and network health (health.nearone.org). Lava showed **0% uptime over 60 days** on both networks. | Active [source: WebFetch of status.near.org, 2026-11-09] |
| FastNEAR status | https://status.fastnear.com/status/main | FastNEAR's own status page. The content is JS-rendered, so I could not read the monitor list. | Live [verified]. Details **[uncertain]** |
| FastNEAR Grafana | https://grafana.fastnear.com | Login-gated Grafana. The NEAR providers page says FastNEAR publishes response-time dashboards. | [verified login page; dashboards not inspected] |
| dRPC status | https://status.drpc.org | Multi-chain provider status page. Not NEAR-specific. | Live [verified] |
| Third-party up/down trackers | isdown.app (QuickNode NEAR), statusgator | They only scrape vendor status pages. No independent latency or correctness data. | [source: WebSearch] |
| ChainList | https://chainlist.org/chain/397 | Static RPC list. | [verified live] |
| docs.near.org providers page | https://docs.near.org/api/rpc/providers | Official provider list with free-tier limits. | [source] |

## 2. Existing repos (GitHub, read via `gh api`)

| Repo | Stars | Last push | What / relevance |
|---|---|---|---|
| [near/near-api-js](https://github.com/near/near-api-js) | 429 | 2026-10-26 | Official JS SDK, v7 single package. Has `JsonRpcProvider` (retry/backoff) and `FailoverRpcProvider`. |
| [near/near-jsonrpc-client-ts](https://github.com/near/near-jsonrpc-client-ts) | 9 | 2026-11-09 | **Official typed TS JSON-RPC client generated from the nearcore OpenAPI spec** (`@near-js/jsonrpc-client`, `@near-js/jsonrpc-types` with Zod schemas). |
| [near/near-api-rs](https://github.com/near/near-api-rs) | 26 | 2026-10-28 | Rust high-level SDK. Per-endpoint retries plus multi-endpoint fallback ("number of retries … before moving on to the next one"). Defaults to FastNEAR endpoints. |
| [near/near-jsonrpc-client-rs](https://github.com/near/near-jsonrpc-client-rs) | 53 | 2026-10-26 | Low-level Rust RPC client (latest release v0.23.0-rc.4, 2026-10-26). |
| near/near-jsonrpc-client-{py,kotlin,swift} | 6 / 9 / 6 | 2026-11 / 2026-11 / 2026-03 | Generated clients for other languages. |
| [r-near/near-kit](https://github.com/r-near/near-kit) | 11 | 2026-11-04 | Alternative TS SDK (kit.near.tools). Retries 408/429/503/5xx with exponential backoff (default 4 retries). Maps `TIMEOUT_ERROR` to `TimeoutError(txHash)`. Has a sandbox. No multi-endpoint failover found in its README **[uncertain]**. |
| [fastnear/js-monorepo](https://github.com/fastnear/js-monorepo) (`@fastnear/api`) | n/a | npm 2026-09-24 | FastNEAR JS API (signing, utils). |
| [Nearblocks/nearblocks](https://github.com/Nearblocks/nearblocks) | 68 | 2026-11-09 | Explorer monorepo: receipt tree UI plus RPC failover backend. |
| [near/read-rpc](https://github.com/near/read-rpc) | 21 | 2025-08-18 | Read-only RPC served from an indexer DB. Its `shadow_data_consistency` feature compared ReadRPC responses with archival RPC (see nearcore #9733). Dormant since 2025-08. |
| [fastnear/explorer-api](https://github.com/fastnear/explorer-api) | 3 | 2026-10-23 | Tx lookup API (≤20 hashes per request) over ClickHouse. |
| [Kampouse/near-balancer](https://github.com/Kampouse/near-balancer) (npm `near-balancer`) | 2 | 2026-06-27 | Round-robin RPC client with backoff and 429 rotation. Its default list includes the now-dead `near.lava.build` and the deprecated `rpc.mainnet.near.org`. |
| [DavidYashar/proven](https://github.com/DavidYashar/proven) | 0 | 2026-11-03 | **Hackathon-era.** Verifies RPC answers client-side against validator signatures and light-client proofs (lib, CLI, verifying proxy, browser). This is the "correctness of one provider" angle. |
| [Web3dakine/near-transaction-investigator](https://github.com/Web3dakine/near-transaction-investigator) | 0 | 2026-11-04 | **Hackathon-era, closest direct competitor.** Node proxy plus web app that looks up a tx via `tx` / `EXPERIMENTAL_tx_status` and analyzes receipt failures. Prototype v0.5. |
| [OptionalityHQ/optionality-adapter](https://github.com/OptionalityHQ/optionality-adapter) | 0 | 2026-11-08 | "NEAR RPC gateway adapter". Not inspected in depth **[uncertain]**. |
| [saka-labs/near-jsonrpc](https://github.com/saka-labs/near-jsonrpc) | 2 | 2026-11-02 | Third-party type-safe TS RPC SDK. |
| [kilnfi/near-validator-watcher](https://github.com/kilnfi/near-validator-watcher) | 7 | 2026-04-21 | Validator monitoring (not RPC). |
| [frolvanya/node-monitoring](https://github.com/frolvanya/node-monitoring) | 0 | 2026-11-09 | Validator block-production monitor (not RPC). |
| [near/near-explorer](https://github.com/near/near-explorer) | 88 | 2024-02-19 (archived) | Legacy explorer. |
| [near/near-indexer-for-explorer](https://github.com/near/near-indexer-for-explorer) | 127 | deprecated | Legacy. |

**Searched and found nothing relevant** (gh search repos, sorted by updated): "near rpc health", "near rpc monitor", "near rpc status", "near rpc compare", "near rpc latency", "near rpc consistency", "near rpc failover", "near rpc benchmark", "near tx timeout", "near tx tracer", "near transaction tracer", "near receipt tree", "near transaction visualizer", "near rpc load balancer", "nearcore rpc monitor". A separate WebSearch for a NEAR RPC latency or consistency benchmark found no independent NEAR benchmark (only vendor claims, plus benchmarks for other chains).

## 3. Features: available vs missing

| Feature | Available? | Where / evidence |
|---|---|---|
| Receipt tree / execution plan visualization | **Yes, mature** | NearBlocks tx sub-pages `/txns/[tid]/execution`, `/tree`, `/enhanced`, `/receipts` ([source tree](https://github.com/Nearblocks/nearblocks/tree/main/apps/frontend/src/app/%5Blang%5D/txns/%5Btid%5D)) |
| Tx failure investigation (receipt errors) | Partial / prototype | Web3dakine/near-transaction-investigator (hackathon prototype). NearBlocks shows failed receipts. |
| Uptime monitoring of major NEAR RPCs | **Yes (up/down only)** | status.near.org monitors FastNEAR, near.org, Lava and archival on both networks. FastNEAR has its own status page and Grafana. |
| Per-method latency / percentile comparison across *all* free providers | **Not found** | Searched as listed in section 2. The providers page notes limits "are not directly comparable across providers" ([docs](https://docs.near.org/api/rpc/providers)). nearcore #10886 (e2e tx latency metric across regions) is **still open**. |
| Cross-provider response consistency (same query, diff providers, diff answers) | **Not found as a product** | Closest: read-rpc's internal `shadow_data_consistency` (nearcore #9733, closed, internal only), and `proven` (verifies one provider cryptographically, not provider-vs-provider). |
| Detecting provider *method support / semantic* drift | **Not found** | Live evidence of drift: see "Live probe findings" below. |
| Client-side RPC failover (JS) | **Yes** | near-api-js `FailoverRpcProvider` ([src](https://github.com/near/near-api-js/blob/master/src/providers/failover-rpc-provider.ts)). near-balancer. NearBlocks backend. |
| Client-side retries/backoff | **Yes** | near-api-js `fetch_json.ts`, near-kit `rpc.ts`, `@near-js/jsonrpc-client` `client.ts` (3 retries, 30 s timeout, 2^n s backoff), near-api-rs `RetryMethod`. |
| Timeout *reason* (NOT_OBSERVED / PENDING / ERROR) | **In nearcore, live on testnet and mainnet 2.14** | nearcore PR #15950 (merged 2026-07-22). I observed it live, see below. |
| Pending vs dropped vs expired tx distinction | **Not yet** | nearcore #15239 open. PR #15781 (adds `Pending`/`DroppedMempoolFull`/`Expired`/`MissingTransaction`) still **open**. |
| SDK that *surfaces* the timeout cause and does a safe "poll, then rebroadcast the same signed tx" | **Not found in near-api-js** | See SDK section. near-api-js drops the cause. docs.near.org now *documents* the procedure ([transactions docs](https://docs.near.org/api/rpc/transactions)) but no SDK implements it end-to-end **[verified for near-api-js; near-kit partial: maps TIMEOUT_ERROR→TimeoutError(txHash), no auto-poll found, uncertain]**. |
| receipt → originating tx lookup | **New RPC method** | `EXPERIMENTAL_receipt_to_tx` is in the OpenAPI spec (from PR #15255) and accepted by FastNEAR testnet/mainnet and dRPC testnet. Returns `UNKNOWN_RECEIPT` for a fake id, not `METHOD_NOT_FOUND` [verified]. |
| Provider reliability *scoring* / automated failure classification | **Only inside closed systems** | NearBlocks backend classifies failures (`isRetryableRpcFailure`, `isSoftEndpointFailure`, `isTransportTimeout`) but only for its own use. Lava did consumer-side provider scoring ([Lava blog](https://www.lavanet.xyz/blog/incentivized-rpc-pools-july-report)), but its public NEAR endpoints are now discontinued. No public NEAR reliability score found. |
| Light-client verification of RPC answers | Yes (new) | DavidYashar/proven |

### Live probe findings (2026-11-09, single client location)

1. **Same request, different error contracts.** `tx` with `wait_until: FINAL` for an unknown hash:
   - FastNEAR testnet: HTTP 408 after **10.25 s**, `TIMEOUT_ERROR` with `cause.info.cause = "NOT_OBSERVED"`.
   - rpc.testnet.near.org: HTTP 408 after 13.3 s, same structured error.
   - **dRPC testnet: HTTP 408 after 2.3 s**, `{"code":30,"message":"Request timeout on the free plan, please upgrade to paid plan"}`. This is non-standard and has no `name`/`cause`, so standard parsers won't classify it.
2. **Method-support drift.** dRPC testnet reports nearcore `2.14.0` but answers `tx_status` (stable since 2.14, PR #16270) with `-32601 "method is not available"`. FastNEAR accepts it.
3. **Node version drift.** FastNEAR testnet and rpc.testnet.near.org run `2.14.0-rc.5`. dRPC reports `2.14.0` with build `unknown`. Mainnet FastNEAR runs `2.14.0`.
4. GC on non-archival: `block` `block_id: 1` on test.rpc.fastnear.com returns `UNKNOWN_BLOCK` / "DB Not Found Error". Docs say non-archival nodes keep about 5 epochs (~2.5 days) ([epoch docs](https://docs.near.org/protocol/network/epoch)).

These are exactly the conditions a cross-provider "Sentinel" would catch automatically.

## 4. nearcore issues / PRs

| # | Type | State | Updated | Title / why it matters |
|---|---|---|---|---|
| [#15239](https://github.com/near/nearcore/issues/15239) | issue | **open** | 2026-03-03 | UX: better feedback when transactions are silently dropped. `tx_status` returns `UnknownTransaction` for both "pending in pool" and "dropped forever". `broadcast_tx_async` hash implies success. **Core pain point for Sentinel.** |
| [#15781](https://github.com/near/nearcore/pull/15781) | PR | **open** | 2026-06-02 | feat(rpc): distinguish pending/dropped/expired in tx_status. Per-node LRU only, and it says multi-node forwarding is not solved. |
| [#15950](https://github.com/near/nearcore/pull/15950) | PR | merged 2026-07-22 | | feat(rpc): report why a tx-status request timed out (`NOT_OBSERVED` / `PENDING` / `ERROR`). Verified live. |
| [#16270](https://github.com/near/nearcore/pull/16270) | PR | merged 2026-08-27 | | Stabilize `EXPERIMENTAL_tx_status` as `tx_status`. |
| [#15255](https://github.com/near/nearcore/pull/15255) | PR | merged 2026-03-18 | | `DBCol::ReceiptToTx`, which backs `EXPERIMENTAL_receipt_to_tx`. |
| [#14982](https://github.com/near/nearcore/issues/14982) | issue | closed 2026-02-07 | | Evaluate `receipt_id → tx_hash` JSON API. |
| [#14886](https://github.com/near/nearcore/issues/14886) | issue | **open** | 2026-02-13 | Feature: RPC receipt endpoint with status and execution outcome (`EXPERIMENTAL_receipt` lacks outcome/logs). |
| [#14865](https://github.com/near/nearcore/pull/14865) | PR | merged 2026-01-12 | | Metric `near_rpc_wait_until_count` (node-side only). |
| [#14644](https://github.com/near/nearcore/pull/14644) | PR | merged 2025-12-18 | | New query methods with structured errors. |
| [#14745](https://github.com/near/nearcore/issues/14745) | issue | closed 2025-12-04 | | Txs "permanently stuck at INCLUDED" on mainnet (reported by QuickNode). |
| [#14164](https://github.com/near/nearcore/issues/14164) | issue | closed 2025-09-24 | | Node WARN "Timeout: tx_status_fetch method". |
| [#14086](https://github.com/near/nearcore/issues/14086) | issue | **open** | 2025-08-20 | RPC perf: tx status and refund receipts. |
| [#13872](https://github.com/near/nearcore/issues/13872) | issue | closed 2025-08-04 | | `tx.status == 'Started'` while `final_execution_status == 'EXECUTED'` on test.rpc.fastnear.com. Status-semantics inconsistency broke tooling. |
| [#13578](https://github.com/near/nearcore/issues/13578) | issue | **open** | 2025-06-04 | Remove request forwarding in tx_status. Non-tracking nodes forward to chunk producers, which is unreliable behind load balancers. |
| [#12367](https://github.com/near/nearcore/issues/12367) | issue | closed 2025-08-04 | | tx status query times out after upgrading to 2.3.0. |
| [#10886](https://github.com/near/nearcore/issues/10886) | issue | **open** | 2026-05-06 | Metric: end-to-end tx latency on mainnet from multiple regions (P50/P90/P99). **Not built yet. A direct Sentinel opportunity.** |
| [#8879](https://github.com/near/nearcore/issues/8879) | issue | closed 2024-08-01 | | Provide guidelines for retrying transaction submission. |
| [#9733](https://github.com/near/nearcore/issues/9733) | issue | closed 2025-04-01 | | Eliminate response mismatch in read-rpc traffic mirroring (internal consistency checking). |
| [#8151](https://github.com/near/nearcore/issues/8151) | issue | closed 2022-12-02 | | Some receipts cannot be found by RPC. |
| [#2488](https://github.com/near/nearcore/issues/2488) | issue | closed 2020-04-20 | | Tx status timeouts when transaction is missing (historical). |
| [#4464](https://github.com/near/nearcore/issues/4464) | issue | closed 2021-07-23 | | `broadcast_tx_commit` behavior change (historical). |
| [#16735](https://github.com/near/nearcore/pull/16735) | PR | merged 2026-11-05 | | Accept and forward "external contract calls" on RPC nodes (new submission path, ECC). Watch it: it may add new tx/call states. **[uncertain impact]** |

Searched nearcore issues/PRs for: TIMEOUT_ERROR, UNKNOWN_TRANSACTION, UnknownTransaction, wait_until, send_tx, tx status, tx_status, EXPERIMENTAL_receipt, broadcast_tx_commit, archival rpc, rpc timeout, "Transaction timed out", "garbage collected transaction rpc", "rpc inconsistent". Searching "rpc inconsistent" and "garbage collected" returned nothing directly. GC is documented, not tracked as a bug.

## 5. SDK / version facts (`npm view`, 2026-11-09)

| Package | Version | Last publish | Notes |
|---|---|---|---|
| `near-api-js` | **7.4.0** | 2026-10-23 | v7 (Jan 2026) is "a single package". It consolidated the modular `@near-js/*` packages. Deps include `@noble/*`, `borsh 2`. |
| `@near-js/accounts`, `providers`, `transactions`, `client` | 2.5.1 | 2025-11-06 | **Frozen since Nov 2025** (superseded by near-api-js v7). Not marked deprecated on npm. |
| `@near-js/jsonrpc-client` | **1.9.0** | 2026-08-11 | Official, generated from the nearcore OpenAPI spec (repo `near/near-jsonrpc-client-ts`). Defaults: 3 retries, 30 s timeout, 2^n·1 s backoff, no client errors retried. Has `experimentalTxStatus`, `sendTx`, and a `ReceiptToTx` symbol in generated functions. Stable `tx_status` was **not found** in the generated functions on main **[uncertain]**. |
| `@near-js/jsonrpc-types` | 1.9.0 | 2026-08-11 | Types plus Zod schemas. |
| `near-kit` | 0.20.2 | 2026-09-24 | Community (r-near) high-level TS SDK. |
| `@fastnear/api` / `@fastnear/utils` | 2.5.0 | 2026-09-24 | FastNEAR JS libraries. |
| near-api-rs (`near-api` crate) | v0.8.7 | 2026-10-28 | Rust. Defaults to FastNEAR endpoints, per-endpoint retries then fallback to the next endpoint. |
| near-jsonrpc-client-rs | v0.23.0-rc.4 | 2026-10-26 | Rust low-level client. |

**OpenAPI spec confirmed:** [`nearcore/chain/jsonrpc/openapi/openapi.json`](https://github.com/near/nearcore/blob/master/chain/jsonrpc/openapi/openapi.json) (~695 KB, last commit 2026-11-06), plus `openrpc.json`. Methods include `send_tx`, `tx`, `tx_status`, `EXPERIMENTAL_tx_status`, `EXPERIMENTAL_receipt`, `EXPERIMENTAL_receipt_to_tx`, `block_effects`, `maintenance_windows`, `health`, `status`, `network_info`, `client_config`, and others. Timeout cause enum includes `NOT_OBSERVED` and `PENDING`.

### near-api-js v7.4 reliability behavior (read from source on `master`)

- `fetch_json.ts`: HTTP 500, 408, 429, 502 and 503 all throw `ProviderError`, but the retry predicate only retries **503, 500, 408** and fetch/network errors. 429 and 502 are **not retried**. `JsonRpcProvider` defaults are 12 attempts, 500 ms initial wait, 1.5× backoff.
- **Consequence:** nearcore returns `TIMEOUT_ERROR` with **HTTP 408** (verified live). So a `send_tx`/`tx` that times out is **silently re-sent up to 12 times**, roughly 12 × 10 s plus backoff ≈ 3+ minutes worst case **[estimate]**. If it still fails, the caller gets a generic `ProviderError('Timeout error')`. The JSON body, including `cause: NOT_OBSERVED|PENDING`, is discarded. Re-sending the same signed tx is idempotent (same hash), so this is safe but slow and opaque.
- `errors/parse.ts`: `TIMEOUT_ERROR` maps to `new TransactionTimeoutError()` **with no fields**, so the timeout cause and tx hash are dropped. `UNKNOWN_TRANSACTION` maps to `UnknownTransactionError(txHash)`.
- `Account.signAndSendTransaction`: the only automatic retry is on `InvalidNonceError` (up to 10, re-signs with a fresh nonce). Default `waitUntil` is `EXECUTED_OPTIMISTIC`. There is **no** built-in "on timeout, poll `tx` then rebroadcast" flow.
- `FailoverRpcProvider`: sequential rotation on **any** error, including deterministic errors such as `InvalidNonce` or contract failure, and it `console.error`s each one. There is no health scoring, latency awareness, or error classification. For `send_tx` this means the same signed tx can be broadcast to several providers (still idempotent).

Official guidance now exists in docs ([transactions](https://docs.near.org/api/rpc/transactions)): default deadline 10 s. `NOT_OBSERVED`: poll `tx`, rebroadcast the same signed tx if absent. `PENDING`: poll again. `ERROR`: retry later. `tx_status` is available from 2.14.0, so use `EXPERIMENTAL_tx_status` until all your nodes are on 2.14+.

## 6. Public endpoint list with status (live probe 2026-11-09 06:45 UTC, `status` method)

### Testnet

| URL | Result | Latency | Official status |
|---|---|---|---|
| https://test.rpc.fastnear.com | OK, testnet, 2.14.0-rc.5 | 0.20 s | Listed (FastNEAR, free) [docs] |
| https://rpc.testnet.fastnear.com | OK, testnet | 0.21 s | FastNEAR builder docs |
| https://archival-rpc.testnet.fastnear.com | OK, testnet | 0.75 s | FastNEAR archival |
| https://near-testnet.drpc.org | OK, testnet, "2.14.0" | 0.53 s | Listed (dRPC, ~2,100 CU/s). **Free plan cuts long waits at ~2 s and lacks `tx_status`.** |
| https://testnet-rpc.intea.rs | OK, testnet | 2.5 s | Listed (Intear, limit not published) |
| https://rpc.testnet.near.org | OK, but ~3.2 s | 3.2 s | **Deprecated.** Rate-limited per the [NEAR blog](https://near.org/blog/deprecation-of-near-org-and-pagoda-co-rpc-endpoints) (final phase from 2025-08-01: 30 RPM / 75 per 10 min). No longer on the providers page. An 8-request burst still returned 200. |
| https://archival-rpc.testnet.near.org | OK, ~3.2 s | 3.2 s | Listed as "Severely rate limited" (deprecated tier: 20 RPM / 50 per 10 min) |
| https://near-testnet.lava.build | **HTTP 410 "This endpoint has been discontinued"** | n/a | Dead. Points to gateway.lavanet.xyz. status.near.org shows Lava at 0% uptime. |
| https://rpc.testnet.pagoda.co | **HTTP 403, `-429 "THIS ENDPOINT IS DEPRECATED!"`** | n/a | Dead (Pagoda wound down) |
| https://api.zan.top/node/v1/near/testnet | HTTP 400 "path not match" | n/a | Listed URL is a ws path. Not working as tried **[uncertain]** |

### Mainnet (for reference)

| URL | Result |
|---|---|
| https://free.rpc.fastnear.com | OK, 0.39 s (official listed free endpoint) |
| https://rpc.mainnet.fastnear.com | OK, 0.56 s, nearcore 2.14.0 |
| https://archival-rpc.mainnet.fastnear.com | OK, 0.83 s |
| https://near.drpc.org | OK, 0.93 s |
| https://rpc.intea.rs | OK, 2.0 s |
| https://rpc.shitzuapes.xyz | OK, 0.53 s |
| https://rpc.mainnet.near.org | OK, 3.6 s (deprecated, rate-limited) |
| https://near.lava.build | HTTP 410 discontinued |
| https://rpc.ankr.com/near | Requires API key now (docs still say free ~30 req/s; **docs out of date**) |
| https://near.blockpi.network/v1/rpc/public | 503 "Apikey not found" (docs say free 20 req/s; **docs out of date**) |
| https://1rpc.io/near | `status` method not supported (-32601) |

## 7. Differentiation opportunities (evidence-backed)

1. **Cross-provider consistency and capability matrix.** No public product does this (section 2 searches). Live drift is real: dRPC lacks `tx_status`, returns a non-standard timeout code 30 at ~2 s, and reports a different build. Ankr and BlockPI listed as "free" on docs.near.org but now require keys. Sentinel can continuously diff the same request across providers (head height and finality lag, `tx` result equality, method support, error-shape conformance to the OpenAPI spec).
2. **Per-method latency and reliability scoring for free endpoints.** status.near.org is binary up/down for ~3 providers. nearcore #10886 (multi-region e2e tx latency P50/P90/P99) is still open. Sentinel could publish exactly that for testnet.
3. **Transaction-fate diagnostics.** Combine `TIMEOUT_ERROR.cause` (PR #15950, live), `tx`/`tx_status` polling on several providers, `EXPERIMENTAL_receipt_to_tx`, and nonce/`block_hash` expiry checks into one verdict: never seen, pending, executed, failed at receipt X, expired, or GC'd on this node (use archival). This fills the gap in open #15239 and open PR #15781 at the *client* side and across nodes, which #15781 says it does not solve.
4. **Safe-retry wrapper for near-api-js v7** (read-only diagnosis plus guidance). near-api-js discards timeout causes, silently retries 408 up to 12×, does not retry 429, and fails over on deterministic errors. A small `@near-sentinel/*` helper or reference provider that follows the official docs procedure is new.
5. **Error-classification taxonomy** (transport / rate-limit / provider-plan-limit / node-timeout(cause) / unknown-tx / GC'd / deterministic-tx-error), published as a spec-anchored table. NearBlocks has an internal classifier but it is not exposed.

## 8. Features that should NOT be rebuilt

- **Receipt-tree / execution-plan visualization.** NearBlocks already has `execution`, `tree` and `enhanced` views. Link out to `https://testnet.nearblocks.io/txns/<hash>` instead.
- **A general block explorer / account history.** NearBlocks, NEAR Rocks (FastNEAR) and Pikespeak cover it.
- **A binary up/down status page.** status.near.org (official) and status.fastnear.com cover it. Only add what they lack (latency percentiles, correctness, capability).
- **A typed JSON-RPC client.** Use `@near-js/jsonrpc-client` (official, OpenAPI-generated) or near-api-js v7. Don't hand-write RPC types.
- **A simple round-robin failover client.** That already exists: near-api-js `FailoverRpcProvider`, near-balancer, near-api-rs fallback.
- **Cryptographic verification of RPC answers.** `proven` (hackathon) covers light-client verification. Reference it if needed.
- **Validator monitoring.** kilnfi/near-validator-watcher and Nearscope cover it.

## 9. Open uncertainties

- Whether Pikespeak or NEAR Rocks render receipt trees (pages are JS-rendered and were not inspected).
- FastNEAR free-tier numeric limits are not published ([FastNEAR docs](https://docs.fastnear.com/docs/rpc-api/api-key) and the providers page say "Not published").
- Whether `@near-js/jsonrpc-client` 1.9.0 on npm exposes stable `tx_status` (grep of generated functions on main found `experimentalTxStatus`, `sendTx` and `ReceiptToTx`, but not `txStatus`).
- Contents of OptionalityHQ/optionality-adapter were not reviewed.
- The near-api-js worst-case timeout duration is an estimate from code constants, not measured.

## Sources

- https://docs.near.org/api/rpc/providers
- https://docs.near.org/api/rpc/transactions
- https://docs.near.org/protocol/network/epoch
- https://near.org/blog/deprecation-of-near-org-and-pagoda-co-rpc-endpoints
- https://status.near.org/
- https://docs.fastnear.com/docs/rpc-api/api-key
- https://www.lavanet.xyz/blog/migrating-your-near-rpc-lavas-got-you-covered
- https://www.lavanet.xyz/blog/incentivized-rpc-pools-july-report
- https://isdown.app/status/quicknode/near-protocol-mainnet-json-rpc-api
- https://github.com/near/near-api-js (src/providers/fetch_json.ts, failover-rpc-provider.ts, json-rpc-provider.ts, errors/parse.ts, src/accounts/account.ts)
- https://github.com/near/near-jsonrpc-client-ts (packages/jsonrpc-client/src/client.ts)
- https://github.com/r-near/near-kit (packages/near-kit/src/core/rpc/*)
- https://github.com/near/near-api-rs (api/src/config.rs)
- https://github.com/Nearblocks/nearblocks
- https://github.com/near/nearcore/blob/master/chain/jsonrpc/openapi/openapi.json
- nearcore issues/PRs linked in section 4
