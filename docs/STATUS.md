# STATUS (resume point)

_Last updated: 2026-11-13. Product, Guard (`guard.karios.testnet`) and Vault (`vault.karios.testnet`) on testnet, NEAR AI agent (4/4 live) and the live dashboard https://64-177-60-105.sslip.io are done and verified. The agent spend guard (`e6efc5b`, from an independent AI-judge screening) is pushed and live. Hackathon deadline: **2026-11-14 23:59 UTC**; no code changes after it._

## How to resume
```bash
pnpm install
pnpm build              # sdk → agent-demo → mcp → api → web → near-ai-agent → guard scripts (7 packages; tsc / vite)
pnpm typecheck
pnpm test               # secrets gate + sdk 346 + mcp 17 (stdio e2e) + api 87 + demo 12 assertions + NEAR AI agent 9 (= 471)
pnpm test:live          # 10 read-only tests against public NEAR RPCs (7 testnet + 3 mainnet)
pnpm test:e2e           # 62 Playwright tests (functional + axe a11y + responsive + keyboard + headers/CSP + judge tour)
pnpm test:contract      # guard 14 + vault 19 Rust unit tests + 27-check on-chain suite on a local neard sandbox (Docker)
pnpm verify             # every check above in one summary table (`--quick`: no network/browser/Docker)
pnpm test:load          # load + soak of the built server against local mock RPCs (17 gates)
pnpm start              # http://127.0.0.1:8080 (dashboard), /docs (OpenAPI)
pnpm demo               # simulated naive-vs-guarded demo (no wallet)
pnpm demo:injection     # simulated prompt-injection attack: naive signs 3/3 attacker payments, guardedSpend 0/3
pnpm proof:testnet      # real-transaction proof (dry run; `-- --i-confirm` sends with your own testnet accounts)
pnpm contract:build     # guard + vault wasm (Docker, Rust 1.86, --cfg near)
pnpm contract:create-account  # optional: contract sub-account with the payer's existing key (dry run; `-- --i-confirm`)
pnpm contract:deploy    # testnet deploy: dry run; add `-- --i-confirm` to send (keys from contracts/guard/.env)
pnpm vault:testnet      # vault on testnet: create vault.<payer> with the payer's key, deploy, live suite, demo policy (dry run; `-- --i-confirm`)
docker compose up -d --build
```
- Plan: `docs/IMPLEMENTATION_PLAN.md`. Analysis: `docs/VERDICT.md`. Evidence: `docs/COMPETITOR_RESEARCH.md`. Contract: `contracts/guard/README.md`.

## Current state: gates actually run (2026-11-11, counts refreshed 2026-11-13)
| Gate | Result |
|---|---|
| `pnpm build` / `pnpm typecheck` (7 packages) | pass / pass |
| Secrets gate (`scripts/check-secrets.mjs`, all tracked files) | pass; self-tested with a planted fake key + seed line (caught) |
| SDK unit | **346/346** (incl. retry safety, intents, vault allowance and payment check with `action`, `guardedSpend`, receiver scam check, key audit, privacy helpers) |
| MCP e2e (built server over stdio, official client) | **17/17** (10 tools) |
| API | **87/87** (incl. vault allowance route, security headers, public simulated benchmark vs key-protected real one, NEP-413 forgery cases, intents, SSE per-IP cap, 413 body limit, rate limits) |
| Demo `--assert` | **12/12** (retry demo 7 + prompt-injection attack demo 5) |
| NEAR AI agent (offline) | **9/9** |
| Live testnet | **7/7** (aging-proof: the old failed tx now only lives on the archival operator → honest WAIT) |
| Live mainnet (read-only) | **3/3**: providers chain_id mainnet (≥ 2 operators), a real recent successful tx picked live → DO_NOT_RETRY, unknown hash → WAIT |
| Dashboard E2E (installed Chrome, or bundled Chromium) | **59/59** (functional, axe WCAG 2.1 AA on every page, 3 viewports, keyboard, judge tour, security headers and 0 strict-CSP violations) |
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
- `origin` = `git@github.com:kariosg/near-sentinel.git` (public).
- History starts with a single fresh root commit authored as `kariosg` with the GitHub noreply email; the repo config keeps no identity.
- `pnpm contract:deploy` runs `pnpm --filter … run deploy` (plain `deploy` would hit pnpm's built-in command). `-- --i-confirm` forwarding verified.

## Uncommitted work
- Code: none. `master` = `e6efc5b` (agent spend guard), pushed and deployed 2026-11-13.
  - What it added: `preflightSpend` `action` (SIGN / ASK_HUMAN / REFUSE, folds in the receiver check), SDK `guardedSpend`, `pnpm demo:injection` (transcript `docs/injection-demo.md`), `preflight_spend` for the NEAR AI agent, action shown in MCP and the dashboard, `pnpm proof:testnet`, docs aligned (471 tests, fixed 24-hour window, exact signing claims).
  - Gates before the commit: `pnpm verify` all PASS (471 tests, live 10/10, e2e 59/59, contracts 14 + 19 Rust + 27/27 sandbox). A clean Linux container ran the README from a fresh clone: all steps pass.
  - Live after deploying: e2e 59/59; receiver checks 15/15; API checks 36/36; walkthrough 15/15; `/api/v1/spend-preflight` returns SIGN for the real payee and REFUSE for `kari0s.testnet`.
  - Final browser audit, live: Lighthouse mobile 93 / desktop 96 (a11y, best practices, SEO 100; CLS 0); OWASP ZAP 0 failures, 62 passed, only the 6 documented low notes (`docs/AUDIT.md` section 4). Nothing to fix.
- **Working tree is dirty (finished, not committed, not deployed): real-wallet test fixes + logo I + chart page.** Waiting for the owner to check it on localhost, then OK commit → push → deploy.
  - Real-wallet test passed on the live site (report `docs/manual-wallet-test-2026-11-13.md`; 4 testnet txs by a team tester's wallet).
  - Fixes: wallet restored after reload (`restoreWallet` in `apps/web/src/wallet.ts`); identity banner hidden while a wallet is connected; vault panels refresh after an owner tx (`onTxSent`); unambiguous dates (`fmtDateTime` in `components/ui.tsx`); honest hints for old example txs.
  - Brand: logo I on dark green `#065f46` with a thin rim, mark centred (icons.tsx, favicon.svg, docs/media/logo.svg, apple-touch-icon.png, og.png via `scripts/render-brand.mjs`).
  - New "How it works" page in the dashboard (`#/how`, `apps/web/src/pages/HowItWorks.tsx`; replaces the standalone `/how-it-works.html`, whose source copy stays in git-ignored `media/how-sentinel-works.html`), linked from Start, README, JUDGING.
  - Local gates (final: green logo + green main buttons, everything else multicolour as before): `pnpm verify` all PASS: 471 tests, live 10/10, e2e 62/62 (axe contrast covers the green), contracts 14 + 19 Rust + 27/27 sandbox. README screenshots retaken with the new look; the 5 README GIFs are kept as the submission-time originals (owner's choice).
  - Still to check with the owner's wallet: restore after reload (on localhost or live after deploy).
  - Also uncommitted: the earlier docs-only STATUS/AUDIT live-results edits.
- Rollback on the server: image `near-sentinel:previous` (= `6cb0787`), data backup `~/backups/sentinel-data-20261113T071554Z.tgz`. The Caddyfile is unchanged.
- `packages/sdk/t.cjs` is a local scratch file, deliberately untracked. `media/` is git-ignored.
- The tag `hackathon-submission` still points to `cc2aa40`; moving it to the final commit is the owner's action.

## Blocked on the owner
- Submitted 2026-11-11 (X post https://x.com/kariosgx/status/2120484078420169114). Results by 2026-11-18 23:59 UTC.
- Before 2026-11-14 23:59 UTC: move the tag `hackathon-submission` to the final commit. No code changes after the deadline.
- Done 2026-11-13: owner-wallet hand test (docs/TESTING.md section B), all steps pass.
- After results: destroy the Vultr instance to stop billing.
- The X post (with the demo video) and the submission form (mainnet payout account).

## Working agreements
- Read-only product. Never sign or submit on the user's behalf. Testnet only.
- Keys only in git-ignored `.env` files the operator fills in; never in chat, logs, git or the API's `.env`.
- Every script that signs: dry run by default, `--i-confirm` to send, refuses non-testnet chains.
- Don't document features that aren't implemented. Verify against the live network, not assumptions.
