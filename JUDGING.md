# Judging guide: every claim, and how to check it

**In one line:** the RPC timed out — did the payment land? NEAR Sentinel answers with proof before the agent signs anything new: landed (`DO_NOT_RETRY`), can still land (`WAIT_AND_RECHECK`), can never land (`SAFE_TO_RETRY`, proven by nonce or validity window on ≥ 2 independent operators), or partly executed (`MANUAL_REVIEW_REQUIRED`). A guard contract only knows about calls that reach it; if the call to the guard itself times out, only the chain (nonce or validity window, across independent operators) can say whether it will land. Sentinel answers that for any transaction, with no contract to adopt. Proven on testnet with real money (links below).

For human judges and AI reviewers. Each claim below links to the command, transaction or file that proves it. Nothing here needs a wallet.

## Fastest paths

| Time | Do | Expect |
|---|---|---|
| 1 min | Open **https://64-177-60-105.sslip.io** | The live dashboard on NEAR testnet. Start page → "Start the 3-minute tour". |
| 10 min | `npm install -g pnpm@8` (if needed), `pnpm install`, then **`pnpm verify`** | One summary table: build, 240 tests, demo, live testnet, 34 browser tests, contracts (if Docker). Exit code 0. |
| 3 min | `pnpm install && pnpm verify --quick` | Same, without network, browser or Docker. |

Verified on 2026-11-11 on Windows (Node 22.16, Chrome) and in a clean Linux container (`mcr.microsoft.com/playwright:v1.65.0-noble`: Node 26, no git checkout, no Chrome; the browser tests used Playwright's bundled Chromium).

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
| MCP server with 7 read-only tools (`check_retry_safety`, `check_intent`, `check_spend_allowance`, …) | `packages/mcp`; `packages/mcp/test/mcp.test.ts` starts the built server over real stdio with the official client |
| SDK and REST API | `packages/sdk/README.md`; OpenAPI at https://64-177-60-105.sslip.io/docs |

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
