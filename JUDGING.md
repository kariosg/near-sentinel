# Judging guide: every claim, and how to check it

**In one line:** the RPC timed out — did the payment land? NEAR Sentinel answers with proof before the agent signs anything new: landed (`DO_NOT_RETRY`), can still land (`WAIT_AND_RECHECK`), can never land (`SAFE_TO_RETRY`, proven by nonce or validity window on ≥ 2 independent operators), or partly executed (`MANUAL_REVIEW_REQUIRED`). A guard contract only knows about calls that reach it; if the call to the guard itself times out, only the chain (nonce or validity window, across independent operators) can say whether it will land. Sentinel answers that for any transaction, with no contract to adopt. Proven on testnet with real money (links below).

For human judges and AI reviewers. Each claim below links to the command, transaction or file that proves it. Nothing here needs a wallet.

## Fastest paths

**Audit report:** [docs/AUDIT.md](docs/AUDIT.md) covers real transactions (Vault 10/10 predictions matched, Guard pay-once with refund), Lighthouse (accessibility, best practices and SEO all 100), OWASP ZAP (0 failures), API fuzzing, axe and a UI/UX audit, with what was fixed.

| Time | Do | Expect |
|---|---|---|
| 1 min | Open **https://64-177-60-105.sslip.io** | The live dashboard on NEAR testnet. Start page → "Start the 3-minute tour". |
| 10 min | `npm install -g pnpm@8` (if needed), `pnpm install`, then **`pnpm verify`** | One summary table: build, 444 tests, demo, live testnet, 59 browser tests, contracts (if Docker). Exit code 0. |
| 3 min | `pnpm install && pnpm verify --quick` | Same, without network, browser or Docker. |
| 1 min | Agent security: [Inspect → ④ Agent keys](https://64-177-60-105.sslip.io/#/inspect?tool=keys) → *Live demo agent keys*, then ③ Vault → *Live agent allowance* → *Would this payment be allowed?* to `attacker.testnet` | `FULL_ACCESS_PRESENT` with the safe spend-only setup; the payment is `BLOCKED · NOT_ALLOWED_RECEIVER` before anything is signed. Mapping to the OWASP agentic top 10: Integrate → *Security & privacy for AI agents*. |

Verified on 2026-11-11 on Windows (Node 22.16, Chrome) and in a clean Linux container (`mcr.microsoft.com/playwright:v1.65.0-noble`: Node 26, no git checkout, no Chrome; the browser tests used Playwright's bundled Chromium).

Integration and sustainability: any project can integrate it today (MCP, Agent Skill, SDK, REST/Docker, contracts); open source (MIT). **Revenue: none today, but a clear model exists** (hosted API plans, enterprise support, optional on-chain fee, grants): [README → Integration, sustainability and business model](README.md#integration-sustainability-and-business-model).

Step-by-step test checklist with expected results (browser, own testnet wallet, source): [docs/TESTING.md](docs/TESTING.md).

## Demo data for testing

Every item is real on NEAR testnet (nothing mocked). Each link opens the live dashboard and runs the check, no wallet. Verdicts were re-checked against the live API on 2026-11-12.

| Scenario | One click | You'll see |
|---|---|---|
| Real money: the guarded agent's payment (reply timed out, it asked Sentinel) | [guarded](https://64-177-60-105.sslip.io/#/inspect?example=guarded) | `DO_NOT_RETRY`: it landed, so paying again would double-pay |
| Real money: the naive agent's first payment | [naive1](https://64-177-60-105.sslip.io/#/inspect?example=naive1) | `DO_NOT_RETRY`: this one landed… |
| Real money: the naive agent's duplicate | [naive2](https://64-177-60-105.sslip.io/#/inspect?example=naive2) | `DO_NOT_RETRY`: …and so did this duplicate (paid twice) |
| The tx that used an unsent payment's nonce | [nonce](https://64-177-60-105.sslip.io/#/inspect?example=nonce) | `DO_NOT_RETRY` on this tx; it is why the unsent one was proven `SAFE_TO_RETRY` |
| Normal success | [success](https://64-177-60-105.sslip.io/#/inspect?example=success) | `DO_NOT_RETRY` |
| Success across 2 receipts | [receipts](https://64-177-60-105.sslip.io/#/inspect?example=receipts) | `DO_NOT_RETRY`, 2 receipts in the graph |
| Contract panic | [panic](https://64-177-60-105.sslip.io/#/inspect?example=panic) | An explained failure |
| Top-level success hiding a failed `ft_burn` | [partial](https://64-177-60-105.sslip.io/#/inspect?example=partial) | `MANUAL_REVIEW_REQUIRED` |
| Guard contract, paid intent `tmwbtoqi6-a` | Inspect → Guard → *Paid intent* | `PAID` on every provider |
| Vault allowance for agent `kariosr.testnet` | Inspect → Vault → *Live agent allowance* | `ACTIVE`, the limits and the amount available now |
| Agent key check for `kariosr.testnet` | [Inspect → ④ Agent keys](https://64-177-60-105.sslip.io/#/inspect?tool=keys) → *Live demo agent keys* | `FULL_ACCESS_PRESENT`: our demo agent keeps a full-access key for simplicity; the result explains the risk and prints the commands for a `spend`-only key |
| Receiver scam check | Inspect → Vault → *Live agent allowance* → *Try a scam lookalike* | `kari0s.testnet` (zero, not o): `BLOCKED · NOT_ALLOWED_RECEIVER` and Receiver check `DANGER`, shown side by side with `karios.testnet` |
| Would this payment be allowed? | Inspect → Vault → *Live agent allowance*, then 0.001 NEAR to `karios.testnet` / 5 NEAR / any other receiver | `ALLOWED` / `BLOCKED OVER_PER_PAYMENT_LIMIT` / `BLOCKED NOT_ALLOWED_RECEIVER`, before anything is signed |

Demo accounts: `karios.testnet` (payer, Vault owner), `kariosr.testnet` (receiver, Vault agent), `guard.karios.testnet` (Guard contract), `vault.karios.testnet` (Vault contract). The Start page also has a glossary of the NEAR terms used (nonce, validity window, receipts, function-call key…).

## Claims

### The problem is real
| Claim | Check |
|---|---|
| A NEAR RPC timeout does not mean the transaction failed | `docs/COMPETITOR_RESEARCH.md` (live observations: HTTP 408 `TIMEOUT_ERROR`, gateway 408s, garbage-collected history). The naive agent in the demo re-signs after a timeout and pays twice. |
| Top-level "success" can hide failed downstream calls | Real testnet tx [`EtpgCjJP…`](https://testnet.nearblocks.io/txns/EtpgCjJPA1WN9MxG17C88GtEU5kf6mx77YxhrWdjMuBd): root `run_buyback` succeeded, `ft_burn` and `ft_transfer_call` panicked. Dashboard: Inspect → "Partially completed". |

### Retry verdicts are evidence-based and conservative
| Claim | Check |
|---|---|
| Four verdicts, decided by an explicit table | `packages/sdk/src/retry.ts` (`decideRetry`), `docs/architecture/STATE_MAPPING.md`; tests in `packages/sdk/test/retry.test.ts` |
| `SAFE_TO_RETRY` needs proof from ≥ 2 **independent operators** (nonce consumed or validity window expired, and not found) | `retry.ts`; defaults in `packages/sdk/src/networks.ts` (FastNEAR, dRPC, Intear). `packages/sdk/test/networks.test.ts` fails if a FastNEAR alias (such as `rpc.*.near.org`, a CNAME to FastNEAR) is ever counted as another operator. |
| "Unknown" is never reported as safe | Live: `pnpm test:live` (unknown tx → `WAIT_AND_RECHECK`); `packages/sdk/test/sentinel.test.ts` |
| A lagging backend in a load-balanced RPC pool cannot turn an executed tx into `SAFE_TO_RETRY` | Delayed re-lookup before a nonce-consumed proof counts (`proofRecheckMs`, `packages/sdk/src/sentinel.ts`); test "load-balanced provider … never SAFE" in `sentinel.test.ts` |
| Signed bytes are the definitive input: key, nonce and block hash are decoded and bound to the hash | `packages/sdk/src/signedtx.ts`, `sentinel.ts` |

### Proven on testnet with real money (2026-11-11)
| Claim | Check |
|---|---|
| Anyone can re-run the naive-vs-guarded story in the browser, no wallet | Live site → Start → **Run it live**: the server replays both agents on a local simulated chain (`POST /api/v1/demo/run`, `examples/agent-demo/src/run-simulated.ts`); naive 2 transfers, guarded 1. API test + browser test cover it |
| Naive agent pays twice, Sentinel-guarded agent pays once | `pnpm demo:testnet` (`examples/agent-demo/src/testnet.ts`). Naive: [`185YtdJZ…`](https://testnet.nearblocks.io/txns/185YtdJZxUCMAaqjRtmSj4MTx51mdiMpjhAPmZ3rZaH) + [`6h2hMxjp…`](https://testnet.nearblocks.io/txns/6h2hMxjpjdYwDF6zXJ5gTwD5MY47UT7thdRaxZM2Pc6h); guarded: [`C59gttNU…`](https://testnet.nearblocks.io/txns/C59gttNUHCaVTHVi2GKCw6zu5C7QcmwPbUuw9NeaXnzS) |
| Critical verdicts on freshly signed transactions: unsent → WAIT; nonce used by another tx → SAFE; landed → DO_NOT_RETRY; garbage → input error | `pnpm demo:critical` (`examples/agent-demo/src/critical.ts`), 5/5. Latest run after the safety fixes: [`6jM2toRM…`](https://testnet.nearblocks.io/txns/6jM2toRMAb9KDNTSNHrCVSGEY5ttJenXnAiirBPE7wnj) |

### On-chain guard: pay at most once per intent
| Claim | Check |
|---|---|
| Contract source and rules | `contracts/guard/src/lib.rs`, `contracts/guard/README.md` |
| Live on testnet, code matches the build | [`guard.karios.testnet`](https://testnet.nearblocks.io/address/guard.karios.testnet), code hash `FvBGyjBMhRe1VT4YVZxDq1qok1YXqZbZsF824TEV4agQ` |
| Duplicate rejected and refunded; failed transfer refunded and released (even larger than the contract's balance); concurrent race pays once | `pnpm test:contract` (14 Rust unit tests + 13 sandbox checks for the Guard); live testnet suite 11/11 (`contracts/guard/scripts/suite.ts`) |
| Read it without a wallet | Live site → Inspect → Guard panel → "Paid intent" (PAID, confirmed by every provider) |

### Sentinel Vault: give an AI agent money without giving it the keys
| Claim | Check |
|---|---|
| Owner-funded allowance with per-payment and rolling 24-hour limits, a receiver allowlist, freeze and owner-only withdraw; pay-once per intent | `contracts/guard/vault/src/lib.rs`; 19 Rust unit tests (`pnpm test:contract`) |
| The agent can hold only a function-call key limited to `spend`: it pays within the policy, and NEAR rejects it (`INVALID_TRANSACTION`) for a direct transfer or any other method | Local sandbox suite, 14 vault checks (`contracts/guard/scripts/vault-suite.ts`, run by `pnpm test:contract`, 27/27 with the Guard) |
| Live on testnet, code matches the build | [`vault.karios.testnet`](https://testnet.nearblocks.io/address/vault.karios.testnet), code hash `7u8KGfkdn4gJCuTBNeqwMfVB2pDR8w2PvXxthMvQuLp9`; live suite 10/10 (`pnpm vault:testnet`), e.g. duplicate rejected [`3hw9fHjb…`](https://testnet.nearblocks.io/txns/3hw9fHjbRJECXuwaW5F4yUGqA4uq2SgjBf2qoJ3VLfEB), over the limit [`2niwBM9n…`](https://testnet.nearblocks.io/txns/2niwBM9nnEUb8DuMWga1bcwLJotjkBExd8ACxPQrAMpt), outside the allowlist [`76yZB8gS…`](https://testnet.nearblocks.io/txns/76yZB8gSxKdTcjLJRmkoqoV7DZ5K8HAgSNqgfqbQN6c). On testnet the suite uses a full-access key (no key is generated there). |
| Owners manage the allowance with their own wallet through **NEAR Connect** (NEAR's recommended connector); each action shows a preview of exactly what will be signed | `apps/web/src/wallet.ts`, `apps/web/src/components/VaultOwnerActions.tsx`; browser test "owner actions" checks the preview args and deposit (real signing needs your testnet wallet) |
| An agent can ask how much it may spend before paying; never overstated | SDK `checkSpendAllowance` (`packages/sdk/src/vault.ts`, `packages/sdk/test/vault.test.ts`: the smallest amount any provider reports wins), MCP `check_spend_allowance`, API `GET /api/v1/allowance`. Live site → Inspect → Agent allowance → "Live agent allowance" (ACTIVE, every provider) |

### For AI agents
| Claim | Check |
|---|---|
| An AI agent on **NEAR AI Cloud** (TEE-hosted model) decides real payment situations with Sentinel as its tools; Sentinel's verdict is binding (a model that proposes paying again is overruled) | `examples/near-ai-agent` (`src/agent.ts` guard, `test/agent.test.ts` 7 offline tests incl. the overrule case); live run `pnpm demo:near-ai` (needs a NEAR AI key) wrote [docs/near-ai-run.md](docs/near-ai-run.md) on 2026-11-12: **4/4 decisions as expected**, each answer signed by NEAR AI, and the model's TEE attestation report contains the same signing address |
| MCP server with 10 read-only tools (`check_retry_safety`, `check_intent`, `check_spend_allowance`, `preflight_spend`, `check_receiver`, `audit_agent_keys`, …) | `packages/mcp`; `packages/mcp/test/mcp.test.ts` starts the built server over real stdio with the official client |
| SDK and REST API | `packages/sdk/README.md`; OpenAPI at https://64-177-60-105.sslip.io/docs |

### Agent security and privacy
| Claim | Check |
|---|---|
| Agent key check: flags full-access keys and recommends a function-call key limited to the Vault's `spend` (cross-checked on every provider) | SDK `auditAgentKeys` (`packages/sdk/src/keys.ts`, `packages/sdk/test/keys.test.ts`), `GET /api/v1/agent-keys`, MCP `audit_agent_keys`; live: Inspect → ④ Agent keys |
| Payment check before signing mirrors the Vault contract's own checks, in the same order, and never says ALLOWED above the smallest amount any provider reports | SDK `preflightSpend` / `decideSpendPreflight` (`packages/sdk/src/vault.ts`, `packages/sdk/test/preflight.test.ts`; order from `contracts/guard/vault/src/lib.rs` `spend`), `GET /api/v1/spend-preflight`, MCP `preflight_spend` |
| Allowance safety score (any receiver, agent can pay itself, per-payment = daily, daily ≥ balance) | SDK `assessAllowanceSafety`; shown in the Vault panel and in `check_spend_allowance` |
| Receiver scam check: lookalike payees (homoglyph, omission, insertion, replacement, transposition, vowel swap, hyphenation, extra words) and address poisoning of raw addresses are DANGER; named accounts that do not exist are NOT_FOUND (worst case across providers for named accounts) | SDK `checkReceiver` (`packages/sdk/src/receiver.ts`, `packages/sdk/test/receiver.test.ts`), `GET /api/v1/receiver-check`, MCP `check_receiver`, and inside every payment check; live: Vault → *Try a scam lookalike* |
| No personal data on-chain by accident | SDK `privateIntentId` (HMAC) and `intentIdPrivacyWarning`; warnings in the Guard and Vault panels |
| Server privacy: audit-log IPs stored only as a salted hash, deleted after 30 days; no cookies or analytics | `apps/api/src/db.ts`, `apps/api/test/privacy.test.ts`, [docs/PRIVACY.md](docs/PRIVACY.md) |
| Mapped to the OWASP Top 10 for Agentic Applications (2026), including what is not covered | [SECURITY.md](SECURITY.md), Integrate page → *Security & privacy for AI agents* |

### Proven with real testnet transactions (2026-11-12)

Before every transaction, Sentinel's payment check (`preflightSpend`, with the receiver check) predicted the outcome. Then the real `spend` was sent to `vault.karios.testnet`. **10/10 predictions matched the contract.** The real 0.005 NEAR payment then got `DO_NOT_RETRY` from the "did it land?" check, and its on-chain record says `Paid`.

| Case | Sentinel predicted | Contract did | Receiver check | Transaction |
|---|---|---|---|---|
| pay 0.005 to the real payee | `ALLOWED` | `PAID` | OK | [`2Bni9jM1…`](https://testnet.nearblocks.io/txns/2Bni9jM1euEew2sDncpj1Dmfmv6EULkukuL8s7rbXBYF) |
| same payment id again (retry) | `DUPLICATE_INTENT` | `DUPLICATE_INTENT` | OK | [`D1omxVt5…`](https://testnet.nearblocks.io/txns/D1omxVt5kkmBFy9WNi2wtM6cj6SyVe4SFAuy7cNiYn7J) |
| prompt-injected lookalike kari0s | `NOT_ALLOWED_RECEIVER` | `NOT_ALLOWED_RECEIVER` | DANGER | [`8ZcwNGSH…`](https://testnet.nearblocks.io/txns/8ZcwNGSHnjrBchEkoG5whRp4DARRfcUZQYeqGjAocTnp) |
| 0.02, over the per-payment limit | `OVER_PER_PAYMENT_LIMIT` | `OVER_PER_PAYMENT_LIMIT` | OK | [`6XMGgd73…`](https://testnet.nearblocks.io/txns/6XMGgd73X7qbrKwHCJvNiMUf3iWDNGF97doHD4YByyNg) |
| pay the vault itself | `INVALID_RECEIVER` | `INVALID_RECEIVER` | OK | [`E3hqTmxb…`](https://testnet.nearblocks.io/txns/E3hqTmxbujvVLSsGNyJ2yLDSi3fijVkpKNFwCpZfcamz) |
| amount 0 | `INVALID_AMOUNT` | `INVALID_AMOUNT` | OK | [`8T5g4jdi…`](https://testnet.nearblocks.io/txns/8T5g4jdiwJD3qpXPUNZabAbwc92HFVia8pg3wmnenwSY) |
| pay 0.01 (2nd) | `ALLOWED` | `PAID` | OK | [`9uoYaaWz…`](https://testnet.nearblocks.io/txns/9uoYaaWzTeN59gnWqogte8Xhxhhbdnw3CG2fvDxDccJb) |
| pay 0.01 (3rd, day total 0.025) | `ALLOWED` | `PAID` | OK | [`3qfaLP6Y…`](https://testnet.nearblocks.io/txns/3qfaLP6YhdybSHB1ZdPvpLFAwo9Msyf3TpAzwKsE7ksc) |
| pay 0.01 more (day total 0.035) | `OVER_DAILY_LIMIT` | `OVER_DAILY_LIMIT` | OK | [`EyXk3Qva…`](https://testnet.nearblocks.io/txns/EyXk3QvahPXM36Dzj8L8ogbHKgTqHxDWJ938bLNgnsL) |
| pay 0.001 while frozen | `FROZEN` | `FROZEN` | OK | [`65a5jPyR…`](https://testnet.nearblocks.io/txns/65a5jPyRYQZBqPvi3NuV14PDmnYhj51zLrVcEHkbVnXB) |

Test allowance: owner = agent = `karios.testnet`, at most 0.01 NEAR per payment and 0.03 NEAR per 24 h, paying only `kariosr.testnet`. The owner withdrew the rest afterwards ([`XZqkCji9…`](https://testnet.nearblocks.io/txns/XZqkCji9Cwdgqtu5RUJZJh9XgtxqwsAgGLfhtqp7Wez)).

### Safety and security of the service itself
| Claim | Check |
|---|---|
| Works on mainnet too (read-only) | `pnpm test:live` → `packages/sdk/test/live-mainnet.test.ts`: mainnet providers answer with chain_id mainnet from ≥ 2 independent operators; a real recent successful mainnet transaction, picked live from a final block, is `DO_NOT_RETRY`; an unknown hash is `WAIT_AND_RECHECK`. Nothing is signed. |
| Read-only: Sentinel never signs or submits | The SDK, MCP server and API contain no signing code. Only the demo agents (`examples/agent-demo`) and the guard's deploy/test scripts sign, with keys from git-ignored `.env` files. |
| SSRF-guarded custom providers, rate limits, body limit, anti-framing headers | `packages/sdk/src/ssrf.ts`, `packages/sdk/test/ssrf.test.ts`, `apps/api/test/api.test.ts` |
| No keys or seed phrases in the repo | `node scripts/check-secrets.mjs` (runs first in `pnpm test`) |
| Fault injection: timeouts, resets, malformed/oversized replies, lying and lagging providers | Live site → Benchmarks → "Run simulated faults" (12/12); `apps/api/src/benchmarks.ts` |

## Honest limits
See `docs/KNOWN_LIMITATIONS.md`. In short: anything that moves funds ran on testnet only (mainnet is exercised read-only by `pnpm test:live`), the contract is not audited, and operator independence relies on labels for custom providers.
