# STATUS (resume point)

_Last updated: 2026-11-12. Everything is done, verified and pushed: product, Guard (`guard.karios.testnet`, live 11/11) and Vault (`vault.karios.testnet`, live 10/10) on testnet, NEAR AI agent (4/4 live), live dashboard https://64-177-60-105.sslip.io (live e2e 46/46 and the docs/TESTING.md walkthrough 20/20 at `3b1cda0`). Submitted 2026-11-11; the owner sent a change request (name, Open Innovation track, description). Hackathon deadline: **2026-11-14 23:59 UTC**; no code changes after it._

## How to resume
```bash
pnpm install
pnpm build              # sdk → agent-demo → mcp → api → web → near-ai-agent → guard scripts (7 packages; tsc / vite)
pnpm typecheck
pnpm test               # secrets gate + sdk 160 + mcp 13 (stdio e2e) + api 53 + demo 7 assertions + NEAR AI agent 7 (= 240)
pnpm test:live          # 10 read-only tests against public NEAR RPCs (7 testnet + 3 mainnet)
pnpm test:e2e           # 46 Playwright tests (functional + axe a11y + responsive + keyboard + optional sign-in + judge tour)
pnpm test:contract      # guard 14 + vault 19 Rust unit tests + 27-check on-chain suite on a local neard sandbox (Docker)
pnpm verify             # every check above in one summary table (`--quick`: no network/browser/Docker)
pnpm test:load          # load + soak of the built server against local mock RPCs (17 gates)
pnpm start              # http://127.0.0.1:8080 (dashboard), /docs (OpenAPI)
pnpm demo               # simulated naive-vs-guarded demo (no wallet)
pnpm contract:build     # guard + vault wasm (Docker, Rust 1.86, --cfg near)
pnpm contract:create-account  # optional: contract sub-account with the payer's existing key (dry run; `-- --i-confirm`)
pnpm contract:deploy    # testnet deploy: dry run; add `-- --i-confirm` to send (keys from contracts/guard/.env)
pnpm vault:testnet      # vault on testnet: create vault.<payer> with the payer's key, deploy, live suite, demo policy (dry run; `-- --i-confirm`)
docker compose up -d --build
```
- Plan: `docs/IMPLEMENTATION_PLAN.md`. Analysis: `docs/VERDICT.md`. Evidence: `docs/COMPETITOR_RESEARCH.md`. Contract: `contracts/guard/README.md`.

## Current state: every gate actually run (2026-11-11)
| Gate | Result |
|---|---|
| `pnpm build` / `pnpm typecheck` (7 packages) | pass / pass |
| Secrets gate (`scripts/check-secrets.mjs`, all tracked files) | pass; self-tested with a planted fake key + seed line (caught) |
| SDK unit | **160/160** (incl. retry-safety hardening, load-balancer re-check, default-provider independence, `checkIntent`, `checkSpendAllowance`, text helpers) |
| MCP e2e (built server over stdio, official client) | **17/17** (10 tools) |
| API | **53/53** (incl. vault allowance route, security headers, public simulated benchmark vs key-protected real one, NEP-413 forgery cases, intents, SSE per-IP cap, 413 body limit, rate limits) |
| Demo `--assert` | **7/7** |
| Live testnet | **7/7** (aging-proof: the old failed tx now only lives on the archival operator → honest WAIT) |
| Live mainnet (read-only) | **3/3**: providers chain_id mainnet (≥ 2 operators), a real recent successful tx picked live → DO_NOT_RETRY, unknown hash → WAIT |
| Dashboard E2E (installed Chrome, or bundled Chromium) | **46/46** (incl. the live Vault panel): 7 functional, 8 axe (WCAG 2.1 AA, 0 serious/critical), 3 viewports × 8 pages (no overflow, no console errors), keyboard, 4 optional-sign-in, guard panel (incl. the live testnet deployment), start-page tour, command palette, mobile drawer, one-click benchmark, modal focus trap, reduced motion |
| Contract unit (Rust, Docker) | **33/33** (guard 14 + vault 19) |
| On-chain sandbox suite (local neard 2.14.0, protocol 88) | **27/27** = vault 14 (a function-call key pays within the policy and is rejected for a direct transfer or any other method; limits, allowlist, duplicates, freeze, owner-only withdraw, failed transfer restored) + guard **13/13** (incl. a failed payment larger than the contract balance, refunded in full) + deploy code-hash match; true concurrent race credits the receiver exactly once |
| Guard on TESTNET (`guard.karios.testnet`) | deployed (tx `Gmym6RR6cCkTYedYMD1KJQ7xiqkXDk3MBaC69LV7ZSbN`, code_hash matches local build); live suite **11/11**; Sentinel `checkIntent` PAID on all 4 providers for intent `tmwbtoqi6-a` |
| Vault on TESTNET (`vault.karios.testnet`) | deployed (tx `5o2YyZWQwEWyJVimMGer3AXMVqydvWcNztkhDGWXf1ne`, code_hash `7u8KGfkdn4gJCuTBNeqwMfVB2pDR8w2PvXxthMvQuLp9` matches local build); live suite **10/10** (owner = agent = payer, full-access key); demo policy `karios.testnet` → `kariosr.testnet` (tx `2QrazB412E6jyU5RhiJEDUSZj4uNgZQRkuzT6bwa5z6y`), `checkSpendAllowance` ACTIVE on all 4 providers |
| Real-testnet agent demo + critical verdicts (`karios.testnet` → `kariosr.testnet`) | naive **2×** / guarded **1×** with real transfers; `demo:critical` **5/5** (unsent → WAIT, nonce consumed → SAFE_TO_RETRY, landed → DO_NOT_RETRY, garbage → input error) |
| Load + soak (built server, mock RPCs, 3 rounds, ~1.8 M requests) | **17/17**: 0 errors / 0 non-2xx; p99 ≤ 126 ms on retry-check; RSS flat after warm-up (+12 MB) |
| Docker | image builds; health OK; all routes 200; runs as non-root `node` |
| `pnpm audit` (all / prod) | No known vulnerabilities (dev-only `uuid` via autocannon pinned to 11.1.1) |
| Docs | 0 broken relative links; full proofreading pass (2026-11-11) |

## Definition of Done (from the original brief) — audit
| Item | Status |
|---|---|
| Runs locally from documented commands | ✅ (clean build + start + e2e auto-start) |
| Backend and frontend communicate | ✅ |
| Real NEAR testnet data retrieved | ✅ |
| Multiple RPC endpoints monitored | ✅ 4 providers / 3 operators, prober + incidents |
| A transaction can be inspected | ✅ |
| Receipt tracing works for supported cases | ✅ (receipts returned with the tx; see limitations) |
| Diagnostics are evidence-based | ✅ each cites observations / receipts |
| Retry safety is conservative | ✅ decision table + mutation checks |
| SDK builds and has integration tests | ✅ (not published to npm) |
| Dashboard displays real data | ✅ |
| Fault simulations produce expected results | ✅ 12/12 + demo 7/7 |
| Security tests pass | ✅ |
| Documentation matches implementation | ✅ |
| Production deployment configuration | ✅ Dockerfile + compose + DEPLOY.md; Vultr setup in `deploy/vultr` + VULTR.md; **live at https://64-177-60-105.sslip.io** (1 vCPU / 1 GB, Caddy + Let's Encrypt, image built locally and loaded with `docker save`) |
| Demo reproducible by another developer | ✅ simulated (no wallet); real testnet run 2026-11-11: naive 2× / guarded 1×; critical verdicts 5/5 (`pnpm demo:critical`) |

## Bugs found by verification (all fixed, most with regression tests)
- Missing access key = successful result with `result.error` (was treated as unknown) → MANUAL. Verified live.
- Provider answers for another tx / malformed answers are now rejected.
- SSRF dev opt-in ran after the port allow-list.
- MCP text suggested re-broadcasting for executed txs.
- `/providers/health?fresh=1` was not rate-limited.
- zod 2020-12 `$schema` broke Fastify's ajv. Fixed by using zod as the only validator.
- Static serving ignored rebuilt assets, and the SPA fallback served HTML for a missing JS file.
- Missing favicon (404).
- **Cold-start race:** the first `/providers/health` returned no providers and the Overview page crashed. Fixed on the server (shared in-flight probe) and the client (guards + page error boundary).
- Dashboard layout issues found by reviewing screenshots (table spacing, chart label collisions, unit overlap, archival tone, plural).
- `.env.example` inline comments were misparsed by Docker Compose; comments moved to their own lines.
- Testnet demo crashed on an unreachable RPC instead of refusing cleanly.
- A documented example sender account was wrong. Corrected from the real fixture.
- **Independent safety review (2026-11-10), all fixed with regression tests and mutation-checked:**
  - A single provider reporting a failed outcome (or one not yet FINAL) could yield `SAFE_TO_RETRY`. Now it must be the same failure at `FINAL` on ≥ 2 independent operators.
  - Expiry was computed from the first provider's block height for the tx's `block_hash`, without checking the block hash. Now each provider uses its own hash-verified height, and the validity period never drops below the protocol default.
  - SDK callers could pass nonce / key / block hash not bound to the tx hash. Those fields can now never yield `SAFE_TO_RETRY`.
  - "Nonce is unused" was claimed even when no nonce could be read. Now low confidence with honest wording.
  - The testnet demo's balance gate covered 3 transfers; the worst case signs 4.
  - A benchmark finishing during shutdown could raise an unhandled rejection.

- **2026-11-11, found by the new gates (all fixed, with tests):**
  - Guard wasm built with plain `cargo` lost every panic message (bare `unreachable` trap) because near-sdk needs `--cfg near`. Found on the real neard sandbox.
  - A naive "concurrent" test sent byte-identical transactions (same nonce → same hash), so it tested nothing. Now two different transactions in flight.
  - axe: red text and primary buttons below WCAG AA contrast; inline links distinguished by colour only; a horizontally scrolling code block not keyboard-focusable.
  - Tables made the Overview overflow on mobile/tablet (now scroll inside the card).
  - Static assets (favicon, JS) counted against the API rate limit → a normal session could hit 429.
  - SSE: headers not flushed until the first event (clients/proxies could hang); stream cap was global, so one client could take every slot (now 10 per IP).
  - NEP-413 verify: a well-formed but wrong-length public key caused a 500 (now a 400).
  - Sandbox runner: Docker's port proxy accepts connections before neard listens; an unref'd abort timer let Node exit mid-poll.

## Next steps
1. ~~Push~~ done 2026-11-11 (`master`). The owner makes the repo **public** (required by 2026-11-14 23:59 UTC).
2. ~~Deploy the guard to testnet~~ done 2026-11-11 (`guard.karios.testnet`, created with `pnpm contract:create-account` from the payer's existing key; no key generated).
3. ~~Production server~~ live 2026-11-11 at https://64-177-60-105.sslip.io (Vultr 1 GB, deploy user `sentinel`, SSH key-only). Update: rebuild locally, `docker save | ssh … docker load`, `up -d --no-build` (VULTR.md §6). Destroy the instance after judging to stop billing.
4. ~~Real-testnet agent demo~~ done 2026-11-11: naive 2× / guarded 1×; `pnpm demo:critical` 5/5.
5. Hackathon submission (owner): video post on X and the form. Rules were checked on 2026-11-11: public repo with a LICENSE (MIT, present), a README "NEAR HACKATHON submission" section (present), and a demo video because the demo runs locally.

## Git setup
- `origin` = `https://github.com/kariosg/near-sentinel.git`.
- History starts with a single fresh root commit authored as `kariosg` with the GitHub noreply email; the repo config keeps no identity.
- `pnpm contract:deploy` runs `pnpm --filter … run deploy` (plain `deploy` would hit pnpm's built-in command). `-- --i-confirm` forwarding verified.

## Uncommitted work
- None after this commit. Full audit and fixes (2026-11-13):
  - **Fixes:** UI/UX fixes, layout shift 0.368 → 0, immutable asset caching, security headers (enforced CSP + strict Report-Only CSP, COOP/CORP; ZAP 10055 fixed, COEP accepted with a reason), cosmetic fixes.
  - **Docs:** `docs/AUDIT.md`.
  - **Gates:** `pnpm verify` all PASS (444 unit/integration, live 10, e2e 59/59, contracts); `pnpm audit` clean.
  - **Real testnet:** Vault 10/10 predictions matched; Guard pay-once 6/6.
- Last deploy: `1d0cd80` (receiver scam check), verified live; rollback image `near-sentinel:previous` = `62997e0`.
- Real testnet proof (2026-11-12): 10/10 Sentinel predictions matched the Vault contract; tx list in JUDGING.md.
- `packages/sdk/t.cjs` is a local scratch file, deliberately untracked. `media/` is git-ignored.
- The tag `hackathon-submission` still points to `cc2aa40`; moving it needs a force tag push (owner's action).
- Git push identity: SSH must greet `kariosg`. On 2026-11-13 it briefly greeted another account until the owner reloaded the key.

## Blocked on the owner
- Nothing blocking. Submitted 2026-11-11 (X post https://x.com/kariosgx/status/2120484078420169114). Results by 2026-11-18 23:59 UTC.
- Before 2026-11-14 23:59 UTC: tag the final commit `hackathon-submission`. No code changes after the deadline.
- After results: destroy the Vultr instance to stop billing.
- The X post (with the demo video) and the submission form (mainnet payout account).

## Working agreements
- Read-only product. Never sign or submit on the user's behalf. Testnet only.
- Keys only in git-ignored `.env` files the operator fills in; never in chat, logs, git or the API's `.env`.
- Every script that signs: dry run by default, `--i-confirm` to send, refuses non-testnet chains.
- Don't document features that aren't implemented. Verify against the live network, not assumptions.
