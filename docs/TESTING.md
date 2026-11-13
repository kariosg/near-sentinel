# Testing guide

Three ways to test NEAR Sentinel, from 5 minutes in a browser to the full suite from source. Everything runs on NEAR **testnet**. Sentinel is read-only: it never signs, sends or stores keys.

Live dashboard: **https://64-177-60-105.sslip.io** (if a "Verify your NEAR account" banner appears, click *Skip*; every feature works without it).

## A. In the browser, no wallet (about 5 minutes)

| # | Do | Expected result |
|---|---|---|
| 1 | Start page → **Run it live** | Two replays on a simulated chain: the naive agent pays **twice**, the Sentinel-guarded agent pays **once** (and, when the payment was lost, re-sends the same bytes instead of signing a new one). |
| 2 | Start page, proof strip → **Check it in Sentinel →** | Inspect opens the real testnet payment `C59gttNU…` → **Do not retry** (`DO_NOT_RETRY`), with per-provider evidence. |
| 3 | Inspect → click each of the 8 example buttons | Each result matches the "You'll see" line under its button (e.g. *Partially completed* → `MANUAL_REVIEW_REQUIRED` with the failed `ft_burn` highlighted in the receipt graph). |
| 4 | Inspect → **② Guard** → *Paid intent*, then *Unused intent* | `PAID` (with receiver, amount, block, and every provider agreeing), then `NOT_RECORDED`. Each status says what it means and what to do. |
| 5 | Inspect → **③ Vault** → *Live agent allowance* | `ACTIVE`: owner → agent, available now, balance, limits, what is left in the 24-hour window, the 0.006 NEAR fee per payment, frozen, allowed receivers. Every ⓘ explains its figure. |
| 6 | Start page → tap or hover an underlined term (*nonce*, *validity window*, *operators*) | A plain-language explanation; **Esc** closes it. The Glossary, Demo accounts and "How Sentinel decides" sections are further down the page. |
| 7 | Benchmarks → **Run simulated faults** | 12 / 12 fault scenarios classified correctly (timeouts, lying or lagging providers, partial executions…). |
| 8 | Press **Ctrl+K**, type "guarded", Enter | The real-money example runs. |
| 9 | Optional: narrow the window to phone width | Everything fits; the menu becomes a drawer. |
| 10 | Inspect → **③ Vault** → *Live agent allowance*, then *Would this payment be allowed?*: receiver `karios.testnet`, amount `0.001`; then amount `5`; then receiver `stranger.testnet` | A **Safety check** score above the details; then `ALLOWED` (cost incl. the 0.006 fee), `BLOCKED · OVER_PER_PAYMENT_LIMIT`, `BLOCKED · NOT_ALLOWED_RECEIVER`. Nothing is signed. |
| 11 | Inspect → **④ Agent keys** → *Live demo agent keys* (direct link: `#/inspect?tool=keys`) | `FULL_ACCESS_PRESENT` for `kariosr.testnet` (our demo agent keeps a full-access key for simplicity), what that risks, and the near-cli-rs commands for a key that can only call the Vault's `spend`. |
| 12a | Inspect → ③ Vault → *Live agent allowance* → **Try a scam lookalike** | `BLOCKED · NOT_ALLOWED_RECEIVER`, and the Receiver check shows `DANGER` for `kari0s.testnet` (zero, not o), with the two names side by side and the differing character highlighted. |
| 12 | Inspect → Guard → type `order-123456789012` as Intent ID | A warning: payment ids are public on-chain forever. |
| 13 | Integrate → **Security & privacy for AI agents** | Six safety layers, the OWASP agentic mapping (with what is *not* covered), and what the server stores. |

All real demo transactions and accounts, with one-click links: [JUDGING.md → Demo data](../JUDGING.md#demo-data-for-testing).

## B. With your own testnet wallet (optional, about 10 minutes)

This tests **Sentinel Vault owner actions**: your own wallet signs through NEAR Connect; the dashboard only prepares and previews the transaction. You need a testnet account (e.g. in Meteor Wallet or MyNearWallet, network **Testnet**) with about 0.2 testnet NEAR, and a second account to act as the agent (any account you own, or `kariosr.testnet` as a receiver-only example).

Go to Inspect → **③ Vault** → *Owner actions*. (Run end to end with a real wallet on 2026-11-13, every step as expected: [manual-wallet-test-2026-11-13.md](manual-wallet-test-2026-11-13.md).)

| # | Do | Expected result |
|---|---|---|
| 1 | **Connect wallet** → pick your wallet → approve | Your account appears. "Your wallet" shows NEAR available, the part reserved for storage, and staked (if any). |
| 2 | Type the agent account in **Agent to manage** | "Allowance … : none yet" (you have not created one). |
| 3 | **Fund / update policy**: per payment `0.01`, per 24 h `0.02`, deposit `0.05` → **Preview transaction** | The preview shows exactly `set_policy({...})` with those limits in yoctoNEAR and the deposit. Nothing is sent yet. |
| 4 | **Sign in wallet** → approve | "set_policy sent" with a NearBlocks link. A few seconds later the allowance line shows `ACTIVE` and the vault balance (a little below 0.05: part of the deposit paid NEAR storage). |
| 5 | In the Vault box above, enter your account as owner and the agent → **Check allowance** | `ACTIVE`, available now **0.01**, every provider agrees. |
| 6 | **Freeze / unfreeze** (checkbox ticked) → Preview → Sign | Allowance line and *Check allowance* show **FROZEN**. |
| 7 | Same tab, untick the checkbox → Preview → Sign | Back to **ACTIVE**. |
| 8 | **Withdraw** → **Max** → Preview → Sign | The whole vault balance returns to your wallet; the allowance balance becomes 0. |

Safety checks you can try (each is refused **before** your wallet opens, with a plain explanation):

| Try | Expected |
|---|---|
| Per payment higher than per 24 h | "The per-payment limit must not be higher than the 24-hour limit." |
| Withdraw more than the vault holds | "The vault holds X NEAR for this agent. Use Max…" |
| Freeze or withdraw for an agent you never funded | "… has no allowance for … You can only … allowances you funded as the owner." |
| Fund an allowance that has receivers, with the receivers field emptied | Asks you to re-enter them, or type `any`, so the allowlist is never removed by accident. |

If the contract itself refuses something (for example, an agent account trying to manage its owner's allowance), the dashboard shows a plain sentence, the NearBlocks link, and the raw error under *Technical details*.

## C. From source (about 10 minutes)

Needs Node ≥ 22.16 and pnpm 8; Docker only for the contract suite.

```bash
pnpm install
pnpm verify            # one table: build, 471 unit/integration tests, demo, 10 live tests, 62 browser tests, contracts (if Docker)
pnpm verify --quick    # same without network, browser or Docker
```

| Command | What it proves |
|---|---|
| `pnpm test` | Secrets gate + 471 tests: SDK 346, MCP server over real stdio 17, API 87, demo 12 (retry demo 7 + prompt-injection attack demo 5), NEAR AI agent 9 (offline) |
| `pnpm test:live` | 10 read-only tests against public testnet and mainnet RPCs |
| `pnpm test:e2e` | 62 browser tests: every flow above, accessibility (WCAG 2.1 AA), phone/tablet/desktop, keyboard, the real demo data |
| `pnpm test:contract` | Docker: Guard 14 + Vault 19 Rust unit tests, then 27 checks on a local NEAR node (incl. a function-call key that can only `spend`) |
| `pnpm test:load` | Load and soak test of the server (17 gates, no memory leak) |
| `pnpm demo` | Simulated: naive agent pays 2 NEAR, guarded agent pays 1 |
| `pnpm start` | This dashboard on http://127.0.0.1:8080 |
| `pnpm demo:near-ai` | Live NEAR AI Cloud agent (needs your own key in `examples/near-ai-agent/.env`; uses credits). Last run: [near-ai-run.md](near-ai-run.md) |

For AI agents: connect the MCP server as shown in [README → From an AI agent](../README.md#from-an-ai-agent-mcp) and ask it to `check_retry_safety` for `C59gttNUHCaVTHVi2GKCw6zu5C7QcmwPbUuw9NeaXnzS` sent by `karios.testnet`. Expected: `DO_NOT_RETRY`.
