# NEAR Sentinel: Deep Analysis and Verdict

> **Historical analysis (2026-11-09), kept for the record.** It predates the build: the engine package became `packages/sdk`, and API keys were added later. The shipped design is in the [README](../README.md) and [ARCHITECTURE](architecture/ARCHITECTURE.md).

Date: 2026-11-09. Target: NEAR HACKATHON (https://nearhackathon.com). Submissions close **2026-11-14 23:59 UTC**, five days away.

Evidence comes from three places:
- Live testnet RPC probes run today (below).
- The ecosystem audit in `docs/COMPETITOR_RESEARCH.md`.
- Reading the `near-api-js@7.4.0` source.

---

## 1. Verdict (short)

**Don't build the master prompt as written. Do build a sharp, agent-focused slice of it.**

| Question | Answer |
|---|---|
| Is the underlying problem real? | **Yes.** Proven live below. Timeouts, ambiguous "unknown", and provider differences really happen. |
| Is the full spec (10 modules, Postgres, Redis, OTel, 10-page dashboard, SDK, benchmarks) doable by Nov 14? | **No.** It is months of work. Half-finished breadth fails the first screening step ("it runs and does what the README says"). |
| Does "RPC infra tool" match the hackathon? | **Weakly.** None of the 13 tracks is about RPC or developer infrastructure. Every money track centres on AI agents, NEAR Intents and Chain Signatures. |
| Is it duplicative? | **Partly.** NearBlocks already has receipt-tree views. status.near.org already does up/down checks. near-api-js already has `FailoverRpcProvider`. A hackathon repo (near-transaction-investigator) already diagnoses failed transactions. |
| Where is the real, unclaimed gap? | (a) **Retry safety:** "did it land / is it safe to re-sign?" (b) **Cross-provider evidence**, meaning provider behaviour actually differs. (c) Making both usable **by AI agents**. |
| Recommendation | Rebuild it as **"Sentinel: a transaction-safety guard for AI agents on NEAR"**. Primary track: **AI Security & Defense**. Also enter **Agent Economy** and **Open Innovation**. |

---

## 2. What the live probes proved (testnet, 2026-11-09)

1. **A timeout is not a failure.**
   - Querying an unknown transaction with `wait_until: FINAL` usually returns HTTP 408 `TIMEOUT_ERROR` with `cause.info.cause = "NOT_OBSERVED"`. Re-verified: FastNEAR after 10.3 s, near.org after 13.3 s.
   - In two earlier probes, no response arrived within the client's 20–30 s budget.
   - dRPC's free plan cuts off at about 2 s with HTTP 408 and a non-standard `code: 30` body.
   - The same query with `wait_until: NONE` returned `UNKNOWN_TRANSACTION` immediately.
   - So the same question gets three or four different failure shapes depending on the provider, including sometimes no answer at all.
2. **"Unknown" from a regular node is not proof the transaction never existed.**
   - Regular nodes return `UNKNOWN_BLOCK` for block 100,000,000. Archival nodes serve it.
   - For older transactions, `UNKNOWN_TRANSACTION` from a regular node is ambiguous.
3. **Providers misreport what they can do.**
   - `archival-rpc.testnet.near.org` reports the same `earliest_block_height` (276,694,855) as a regular node in `status`, yet it serves block 100M.
   - You have to test a provider's capabilities, not trust its self-description.
4. **Healthy providers agree.**
   - On a real transaction (`49KZfj1Y…`), four endpoints returned identical status, receipt count and tokens burnt (to the yoctoNEAR).
   - So "disagreement detection" mostly surfaces lag, archival gaps and policy differences, not lying providers. The pitch must not overclaim.
5. **Method support differs between providers.** dRPC testnet rejects the newly stabilised `tx_status` with `-32601 "method is not available"`, but accepts `tx` and `EXPERIMENTAL_tx_status`. FastNEAR accepts all three (re-verified live). Clients should use `EXPERIMENTAL_tx_status`.
   - _Correction:_ an earlier draft of this analysis wrongly said the audit was wrong about this. It was right: that test had used `tx`, not `tx_status`.
6. **The validity window is shorter than it sounds.** `transaction_validity_period` is 86,400 blocks. Measured testnet block time is about 0.58 s, so a signed transaction stays includable for **about 14 hours**, not a day.
7. **Endpoint churn is real.**
   - Lava testnet is dead (HTTP 410). Pagoda is deprecated.
   - Ankr and BlockPI are listed as free in NEAR's docs but now need an API key.
   - near.org's own RPC is deprecated and capped at 30 requests/min.

## 3. The real retry-safety gap (checked against the source)

- `near-api-js@7.4.0` (`lib/index.js` ~L3015–3100) retries **every** JSON-RPC call, including `send_tx`, up to 12 times on HTTP 408/500/503 and network errors. `FailoverRpcProvider.sendTransaction` (~L2093) then moves to the next provider.
- That re-sends the **same signed transaction** (same hash and nonce), which NEAR deduplicates, so this part is safe.
- **The danger is one level up.** The app, or an AI agent, gets a `TimeoutError` and builds and **re-signs a new transaction with a new nonce**. Now the transfer can execute twice.
- AI agents are the worst case. An LLM tool loop that sees "error: timeout" will usually just call `transfer` again.
- NEAR's docs describe the safe procedure: poll the status, then re-broadcast the *same* signed transaction. No SDK packages it as one call that returns evidence.
- Open nearcore issue #15239 says pending and dropped transactions look identical. PR #15781 fixes that per node only, not across nodes.

**That is the product:** one call, `checkRetrySafety(txHash, signer)`, that queries several providers in parallel, includes an archival one, and returns:
- `DO_NOT_RETRY`: the transaction was found on any provider.
- `WAIT_AND_RECHECK`: still inside its validity window, or the providers can't confirm either way.
- `SAFE_TO_RETRY`: only after the transaction's validity window has expired *and* the signer's nonce shows no use.
- `MANUAL_REVIEW_REQUIRED`: evidence conflicts.

Each answer comes with its evidence. This is deterministic, testable, and nobody has shipped it.

## 4. What NOT to build (already exists)

- A receipt-tree explorer UI: NearBlocks has `/txns/<hash>/execution`. Show a compact tree in the report instead of a full explorer.
- An up/down status page: status.near.org and FastNEAR's status page exist.
- A typed RPC client or basic failover: `@near-js/jsonrpc-client@1.9.0` and near-api-js `FailoverRpcProvider` exist. **Build on them.**
- Postgres, Redis, OpenTelemetry or a 10-page dashboard: no judge will reward these in five days.

## 5. Ideas ranked for this hackathon

Scores are my judgement (1–5), not data.

| # | Idea | Track(s) | Fit | Novelty | Doable by Nov 14 | Reuses today's work |
|---|---|---|---|---|---|---|
| **A** | **Sentinel Guard for Agents**: an MCP server and SDK giving agents `inspect_tx`, `check_retry_safety` and `provider_health`, plus a demo where an agent hits a timeout, *would have* double-paid, and Sentinel stops it. | AI Security & Defense, Agent Economy, Open Innovation | 5 | 4 | 5 | 5 |
| B | **Agent Spend Firewall**: a NEAR contract plus function-call access keys enforcing per-agent spend limits, allowed receivers and rate limits, with Sentinel as the off-chain verifier. | AI Security & Defense | 5 | 3 (crowded track idea) | 3 (needs a Rust contract and audit care) | 2 |
| C | **Pay-per-verification API**: Sentinel answers paid per call by agents in NEAR or stablecoins (x402-style). Agents buying trust from agents. | Agent Economy | 4 | 4 | 2 (payments plus Intents in five days is risky) | 3 |
| D | **NEAR Infra Reliability Thesis**: re-runnable, open-data analysis of RPC provider reliability, latency and capability drift, published as a dashboard and notebook. | Investment Thesis | 3 | 4 (likely little competition) | 4 | 4 |

**Recommendation:**
- Build **A** as the main submission. If time allows, add B's on-chain spend limit as a stretch goal inside the same repo.
- **D** can be a second, independent submission. The rules allow two per person if each README names the other. It reuses the same probe engine and needs mostly analysis, not new code.

## 6. Scope for A, all actually runnable

1. `packages/core` (shipped as `packages/sdk`): provider pool with capability probing (archival? `tx_status` supported? wait cap?), parallel `EXPERIMENTAL_tx_status` queries, a deterministic state classifier, the retry-safety engine with evidence, and a receipt tree from `receipts_outcome`.
2. `packages/mcp`: an MCP server exposing those tools to Claude, Codex or any agent.
3. `apps/api`: a small Fastify REST API (`/inspect`, `/retry-check`, `/providers/health`), with SSRF-safe custom RPC URLs.
4. `apps/web`: one focused dashboard with live provider health, a transaction inspector, a retry verdict with evidence, and a receipt tree. Real data only.
5. Fault-injection proxy plus fixtures: timeout, 429, malformed JSON, stale data, missing receipts. These drive deterministic tests and the demo.
6. A demo script: a testnet agent transfer, a forced timeout, a naive agent re-signs (two transfers), and a guarded agent gets `WAIT_AND_RECHECK` then `DO_NOT_RETRY` (one transfer). Recorded for the X post.

Out of scope: Postgres, Redis, OpenTelemetry, billing (API keys were added later), multi-page marketing. Listed in KNOWN_LIMITATIONS.
