# Changelog

## 0.1.0 (2026-11-10)

First release, built for NEAR HACKATHON (Nov 2026).

### Receiver scam check (2026-11-12)
- **What it is:** SDK `checkReceiver`, `GET /api/v1/receiver-check` and MCP `check_receiver` (10 read-only tools). The same check also runs inside every payment check as `receiverCheck`.
- **What it flags:**
  - lookalikes of a known payee, labelled with the technique, using the typosquatting classification: homoglyph, omission, insertion, replacement, transposition, vowel swap, hyphenation, extra words;
  - address poisoning of raw addresses (same first and last 4 characters);
  - named accounts that do not exist;
  - raw addresses;
  - first-time payees (as an info note).
- **How:** worst case across providers for named accounts (any NOT_FOUND counts); raw addresses use the freshest answer.
- **UI:**
  - a "Receiver check" block in the Vault payment check, showing the two names side by side with the differing characters highlighted;
  - a one-click "Try a scam lookalike" demo (`kari0s.testnet`).
- **Docs:** README, JUDGING, TESTING step 12a, SECURITY, threat model, KNOWN_LIMITATIONS, API/SDK/MCP docs and the Agent Skill.
- **Tests:** SDK 326, API 83, MCP 17, browser 52. Findings from two independent reviews fixed before merge.
- **Real testnet proof:** 10 real `spend` transactions, and every outcome matched Sentinel's prediction (3 paid, 7 refused with the predicted code, including the lookalike `kari0s.testnet` flagged DANGER). The real payment then got DO_NOT_RETRY. See JUDGING.md.

### Agent security and privacy (2026-11-12)
- **Agent key check** (SDK `auditAgentKeys`, `GET /api/v1/agent-keys`, MCP `audit_agent_keys`, Inspect → ④ Agent keys). It lists every access key on an agent account, cross-checked on every provider, and flags full-access keys. A function-call key limited to the Vault's `spend` is graded least privilege, and the result prints the near-cli-rs commands for that safe setup. A missing account is confirmed with `view_account`, because providers answer an empty key list for unknown accounts.
- **"Would this payment be allowed?"** (SDK `preflightSpend` / `decideSpendPreflight`, `GET /api/v1/spend-preflight`, MCP `preflight_spend`, a form in the Vault panel). It runs the Vault contract's own checks in the contract's order, before anything is signed. It never answers ALLOWED above the smallest amount any provider reports. It is advisory: the contract stays the final judge.
- **Allowance safety score** (SDK `assessAllowanceSafety`, an optional `safety` field on allowance checks, the Vault panel, `check_spend_allowance`). It flags any receiver allowed, an agent that can pay itself, a single payment that can use the whole day, and a day that can empty the vault.
- **Private payment ids**: SDK `privateIntentId(secret, reference)` (HMAC) and `intentIdPrivacyWarning`. The Guard and Vault panels warn when an id looks like an email, a phone number or a long number.
- **Server privacy**:
  - audit-log IPs are stored only as a salted HMAC (optional `AUDIT_IP_SALT`), raw IPs from older databases are converted on open, and rows are deleted after 30 days;
  - retention also runs at start-up;
  - API request logs and the Caddy access log no longer contain client IPs.
- **Docs and UI**:
  - `docs/PRIVACY.md`;
  - `SECURITY.md` mapping to the OWASP Top 10 for Agentic Applications (2026), including what is not covered;
  - new threat-model rows;
  - a "Security & privacy for AI agents" card on Integrate;
  - README section, JUDGING claims and demo rows, TESTING steps 10-13.
- Shown everywhere a judge looks:
  - Start tour step 7 "Check an agent's keys and a payment before signing";
  - an "Agent security & privacy" card on Start;
  - deep links `#/inspect?tool=keys|vault|guard|check` (tour, Ctrl+K, docs);
  - a 15-second GIF (`docs/media/agent-security.gif`) in the README;
  - security rows in the README NEAR-technology table, JUDGING fastest paths and the TESTING links.
- MCP server now has 9 read-only tools. Tests: SDK 207 (+ live), API 73, MCP 16, browser 51; an independent review's findings fixed (worst-case provider consensus for keys, no lock-out advice, no silent demo-vault default, stricter "not used" check, hourly retention, secure_delete).

### Judge helpers: real demo data, glossary, diagrams, GIFs (2026-11-12)
- Dashboard: one shared list of real testnet demo data (`apps/web/src/demoData.ts`). The Inspect page now has 8 one-click examples in two groups (the real-money demo and real edge cases); each shows what you will see as visible text, not only on hover. The Start page proof strip links straight into Sentinel ("Check it in Sentinel"), and a new tour step checks the real-money payment.
- Start page: "Real demo data, no wallet needed" (transactions with expected verdicts, the demo accounts with explorer links) and a glossary; a decision tree showing how a verdict is chosen (mirrors `packages/sdk/src/retry.ts`).
- Plain-language tooltips (tap, hover or keyboard) for nonce, validity window, independent operators, intent, allowance and function-call key; Inspect gets an intro with jump links to its three tools and help on where signed-transaction bytes come from; Ctrl+K gets the real-money examples and the glossary. Choosing an example from Ctrl+K while already on Inspect now runs it.
- README: 3 mermaid diagrams (the problem, the decision tree, the architecture) and 3 short GIFs (`scripts/record-gifs.mjs`); JUDGING.md: a "Demo data for testing" table with one-click links to the live site.
- Vault panel shows everything the contract reports, each with an ⓘ help: owner and agent, available now, vault balance, limits, what is left in the 24-hour window and when it resets, the 0.006 NEAR fee per payment, frozen, allowed receivers, plus what the status means and what to do next. The Guard panel explains each status the same way.
- Owner actions: the connected wallet's balance (available, reserved for storage, staked), the current allowance for the typed agent, guidance per tab, a Max button for withdraw, and checks before anything is signed (limits, account ids, wallet balance, vault balance, "not your allowance"). Contract and wallet errors are shown in plain language with the technical details one click away, and a transaction that fails on-chain is never reported as sent.
- `docs/TESTING.md`: a step-by-step test checklist with expected results (browser without a wallet, your own testnet wallet, from source), linked from README and JUDGING.
- New brand: the "Shield S" logo (a shield holding the S of Sentinel, ending in a mint dot where the payment lands) and a stacked "NEAR / Sentinel" name, in the app, favicon, iPhone home-screen icon, README header, share image and GIFs (all 4 GIFs re-recordable with `node scripts/record-gifs.mjs`). Each logo copy now has its own gradient id, which also fixes the logo background on phones.
- Share preview: page description plus Open Graph and X card tags with a preview image (`apps/web/public/og.png`), so a shared link shows a card instead of a bare URL.
- Independent review fixes: the decision tree now follows `packages/sdk/src/retry.ts` exactly; Owner actions re-read the live allowance before validating, pre-fill the current limits and receivers (an allowlist is never removed by accident), say "Failed on-chain" when a sent transaction failed, and count staked NEAR correctly; tooltips announce their text to screen readers and close with Escape.
- README "Integration, sustainability and business model" (how any project integrates it; open source MIT; revenue: none today, but a clear model exists: hosted API plans, enterprise support, optional on-chain fee, grants), a matching card on the Integrate page and a line in JUDGING.
- Phone polish from a visual review of every page: wide tables and code blocks show an edge fade with an arrow when more content is off-screen (and become keyboard-focusable then); the hero diagram is hidden on phones where it would be too small to read; chart time labels no longer run together; the proof strip and the "Transactions to try" rows no longer wrap awkwardly; the Inspect mode tabs stay on one line.
- 12 new browser tests (46 in total). No change to the SDK, API, MCP server or contracts.

### Sentinel Vault (2026-11-11)
- New contract `contracts/guard/vault` (crate `sentinel-vault`): an owner-funded allowance for an AI agent with a per-payment limit, a rolling 24-hour limit, a receiver allowlist, freeze and owner-only withdraw. The agent calls `spend` with no deposit, so it can hold only a function-call key limited to `spend`. Pay-once per (owner, agent, intent); a failed transfer restores the balance and allowance.
- 19 Rust unit tests; 14 sandbox checks, including a function-call key that pays within the policy and is rejected by NEAR for a direct transfer or any other method (sandbox total 27/27 with the guard).
- Live on testnet as `vault.karios.testnet` (code hash matches the build), live suite 10/10, and a demo allowance for the dashboard. `pnpm vault:testnet` reproduces it with the payer's existing key.
- Read-only support everywhere: SDK `checkSpendAllowance`, MCP `check_spend_allowance` (7 tools), API `GET /api/v1/allowance`, dashboard "Agent allowance" panel; the smallest available amount any provider reports wins.
- `pnpm verify` (one summary table of every check) and `JUDGING.md` (each claim with its proof).

### Positioning from a full directory scan (2026-11-12)
- NEAR AI live run: 4/4 decisions as expected on `Qwen/Qwen3.6-35B-A3B-FP8` (NEAR AI-hosted, thinking off, answers capped), every answer signed, TEE attestation report contains the signing address (`docs/near-ai-run.md`). `pnpm verify` only runs the paid step with `--near-ai`.
- Headline is now the question only Sentinel answers: "The RPC timed out. Did the payment land?" (landed / can still land / can never land, proven / partly executed). Several other entries claim "never pay twice" with duplicate-key contracts; the README explains what those cannot decide.
- "Run it live" shows both failure modes and the guarded agent's verdict path (WAIT → re-send the same bytes → paid once, never signed a new transaction); the API returns decisions and signed counts.
- Agent Skill (`skills/near-sentinel/SKILL.md`) and a guide for running Sentinel next to NEAR's official MCP Server (`docs/integrations/near-mcp.md`), citing NEAR's own timeout guidance.

### NEAR AI agent and NEAR Connect (2026-11-12)
- Start page **Run it live**: `POST /api/v1/demo/run` replays the naive-vs-guarded agents on a local simulated chain (no network, no funds) and shows naive 2 transfers vs guarded 1; the demo logic is shared with `pnpm demo` (`examples/agent-demo/src/run-simulated.ts`).
- Start page shows the real-money proof on the first screen; `scripts/record-wow.mjs` records a short clip; read-only mainnet live checks (10 live tests).
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
