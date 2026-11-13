# Sentinel Guard: on-chain idempotency for agent payments

NEAR Sentinel tells an agent, off-chain, whether a retry is safe. **Sentinel Guard enforces it on-chain**: a payment sent through the guard is forwarded **at most once per `(payer, intent_id)`**, however many times the agent retries.

```
agent ──pay(intent_id="order-42", receiver_id)──▶ guard ──transfer──▶ receiver
agent ──pay(intent_id="order-42", …) again ─────▶ guard: panic DUPLICATE_INTENT (deposit refunded by NEAR)
```

| Method | Kind | What it does |
|---|---|---|
| `new()` | init | Called once at deploy. No owner, no admin, no upgrade method. |
| `pay(intent_id, receiver_id)` | payable | Records the intent, then forwards `deposit − 0.005 NEAR` to `receiver_id`. A repeated `intent_id` from the same payer panics `DUPLICATE_INTENT`. |
| `on_transfer(...)` | private callback | Transfer OK → status `Paid`. Transfer failed → record deleted and full deposit refunded, so the intent can be retried. |
| `get_intent(payer_id, intent_id)` | view | `{payer_id, intent_id, receiver_id, amount, block_height, status}` or `null`. |
| `storage_fee()`, `version()` | view | `0.005 NEAR` (kept for record storage), `0.1.0`. |

Rules enforced on-chain:
- `intent_id`: 1–64 chars of `A-Z a-z 0-9 . _ : -`. Quotes are rejected, so `EVENT_JSON` logs can't be forged.
- Deposit must exceed the storage fee.
- The receiver can't be the guard itself.
- Events: NEP-297 `EVENT_JSON` with standard `sentinel_guard`, events `intent_recorded`, `intent_paid`, `intent_released`.

From an agent, re-calling `pay()` with the **same** `intent_id` is always safe. Sentinel's read-only `checkIntent` (SDK), `check_intent` (MCP) and `GET /api/v1/intents` (API) report `PAID / PENDING / NOT_RECORDED / CONFLICTING / UNKNOWN` with per-provider evidence.

## Build and test

Everything runs in Docker, so you need Docker and nothing else for the contract:

```bash
pnpm contract:build        # wasm via Rust 1.86 in Docker → contracts/guard/target-docker/.../sentinel_guard.wasm + sentinel_vault.wasm
pnpm test:contract         # 33 Rust unit tests (guard 14 + vault 19) + full on-chain suite (27 checks) on a throwaway local NEAR sandbox
```

- `--cfg near` is required when building with plain `cargo`. Without it, near-sdk 5.27 turns every panic into a bare wasm trap, and the readable `DUPLICATE_INTENT` message is lost. This was found by the sandbox suite.
- The sandbox runs **neard 2.14.0, protocol 88**, the same as NEAR testnet in Nov 2026. Every account and key in it is created in memory for one run and discarded.

The guard's on-chain suite (`scripts/suite.ts`) runs these checks on the sandbox and on testnet (13 on the sandbox, which adds a failed payment larger than the contract's own balance; 11 on testnet, which has no second payer):

1. The contract answers `version` and `storage_fee`.
2. The first `pay()` forwards the exact amount; status becomes `Paid`.
3. A duplicate `pay()` panics `DUPLICATE_INTENT`; the receiver is not credited and the deposit is refunded (payer pays gas only).
4. A transfer to a missing account releases the intent and refunds the full deposit.
5. A released intent can be paid again.
6. `on_transfer` is private.
7. Deposit ≤ storage fee is rejected.
8. A quoted `intent_id` is rejected.
9. Paying the guard itself is rejected.
10. **Two different transactions for one intent, in flight at the same time:** the receiver is credited exactly once, and the other gets `DUPLICATE_INTENT`.
11. The same `intent_id` from another payer is independent.
12. Sentinel `checkIntent` returns `PAID` / `NOT_RECORDED`.

## Live deployment

`guard.karios.testnet` on testnet. Deploy tx [`Gmym6RR6…`](https://testnet.nearblocks.io/txns/Gmym6RR6cCkTYedYMD1KJQ7xiqkXDk3MBaC69LV7ZSbN), on-chain `code_hash` `FvBGyjBMhRe1VT4YVZxDq1qok1YXqZbZsF824TEV4agQ` (equal to the local Docker build). The live suite passed 11/11 on testnet on 2026-11-11 (check 12 needs a second payer and runs in the sandbox suite).

## Deploy to testnet (your account, your keys)

1. `cp contracts/guard/.env.example contracts/guard/.env` and fill it in **yourself** (git-ignored; never paste keys in chat or commit them). Either:
   - set `GUARD_CONTRACT_ID` and `GUARD_CONTRACT_PRIVATE_KEY` for a contract account you already created and funded (~5 testnet NEAR), or
   - set `GUARD_CONTRACT_ID=guard.<payer>` plus the `GUARD_TEST_PAYER_*` values, then `pnpm contract:create-account` (dry run) and `pnpm contract:create-account -- --i-confirm`. It creates the sub-account with 5 NEAR and the payer's **existing** public key, so no new key is generated; `deploy` then uses the payer key automatically.
3. `pnpm contract:deploy` runs a dry run: it checks `chain_id=testnet`, the key is FullAccess, the account has no code, and enough balance. It prints the plan and the wasm hash.
4. `pnpm contract:deploy -- --i-confirm` deploys and calls `new()`, then verifies the on-chain `code_hash` matches the local wasm.
5. Optional live test: fill the `GUARD_TEST_*` values, then `pnpm contract:test:testnet` (dry run) and `pnpm contract:test:testnet -- --i-confirm`. It uses 0.01 NEAR per payment; at most 0.03 NEAR reaches the receiver, plus gas.

The scripts refuse any network whose `chain_id` is not `testnet` (or `sandbox` for the local suite), and never print a key.

## Sentinel Vault

A second contract in this folder (`vault/`, crate `sentinel-vault`): **give an AI agent money without giving it the keys.**

| Method | Who | What it does |
|---|---|---|
| `set_policy(agent_id, per_payment_max, daily_max, allowed_receivers)` | owner, payable | Creates or updates the policy for `(caller, agent_id)`. The deposit pays for storage; the rest becomes the balance. Empty allowlist = any receiver (max 20). |
| `deposit(agent_id)` | owner, payable | Tops up the balance. |
| `set_frozen(agent_id, frozen)` | owner | Stops or resumes all spending. |
| `withdraw(agent_id, amount)` | owner | Takes back up to the whole balance (restored if the transfer fails). |
| `spend(owner_id, intent_id, receiver_id, amount)` | agent, **no deposit** | Pays `amount` from the owner's allowance. A function-call key limited to `spend` can call it. |
| `on_spend(...)` | private callback | Transfer OK → `Paid`. Failed → record removed, balance and daily allowance restored, intent freed. |
| `get_policy(owner_id, agent_id)`, `get_spend(owner_id, agent_id, intent_id)`, `record_fee()`, `version()` | view | `get_policy` includes `available_now` = min(per-payment limit, daily headroom, balance − fee); 0 when frozen. |

Rules enforced on-chain: each `(owner, agent, intent_id)` pays at most once (`DUPLICATE_INTENT`); `OVER_PER_PAYMENT_LIMIT`, `OVER_DAILY_LIMIT` (a fixed 24 h window that restarts with the first spend after it expires), `NOT_ALLOWED_RECEIVER`, `FROZEN`, `NO_POLICY`, `INSUFFICIENT_VAULT_BALANCE`; 0.006 NEAR per spend is kept from the balance for the record's storage; policies are keyed by `(owner, agent)`, so nobody can claim someone else's agent. NEP-297 events with standard `sentinel_vault`. No admin or upgrade method in the contract.

**The restricted key.** The owner gives the agent a key that can only call `spend` on the vault (run by the owner; the key never leaves their machine):

```bash
near account add-key <agent>.testnet grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id vault.example.testnet --function-names spend \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send
```

The sandbox suite (`scripts/vault-suite.ts`, 14 checks) proves it: with only that key the agent pays within the policy, and NEAR rejects it (`INVALID_TRANSACTION`) for a direct transfer of the agent's own NEAR or for any other vault method. It also checks duplicates, both limits, the allowlist, a failed transfer being restored, freeze, and that only the owner can withdraw.

**Live on testnet:** `vault.karios.testnet`, deploy tx [`5o2YyZWQ…`](https://testnet.nearblocks.io/txns/5o2YyZWQwEWyJVimMGer3AXMVqydvWcNztkhDGWXf1ne), on-chain `code_hash` `7u8KGfkdn4gJCuTBNeqwMfVB2pDR8w2PvXxthMvQuLp9` (equal to the local Docker build). Live suite 10/10 on 2026-11-11 with owner = agent = the payer (a full-access key, because no key is generated on testnet). A demo policy (owner `karios.testnet` → agent `kariosr.testnet`, 0.05 NEAR per payment, 0.1 NEAR per day, only to `karios.testnet`; tx [`2QrazB41…`](https://testnet.nearblocks.io/txns/2QrazB412E6jyU5RhiJEDUSZj4uNgZQRkuzT6bwa5z6y)) backs the dashboard's "Live agent allowance" example.

Deploy your own: fill the `GUARD_TEST_*` values in `.env`, then `pnpm vault:testnet` (dry run: creates `vault.<payer>` with the payer's **existing** key, deploys, runs the live suite, leaves a demo policy) and `pnpm vault:testnet -- --i-confirm`.

Sentinel reads it without signing: SDK `checkSpendAllowance`, MCP `check_spend_allowance`, API `GET /api/v1/allowance` (the smallest `available_now` any provider reports wins).

## Limitations

- Not audited (Guard and Vault). Testnet only.
- Neither contract has an owner or upgrade method, but each **account** keeps its FullAccess key, so the key holder could redeploy the code. For a production deployment, delete the account's access keys after deploying to lock it.
- The guard protects payments **made through it**. A payment the agent sends by another route (a plain transfer) is not covered. Sentinel's off-chain retry check covers those.
- The 0.005 NEAR storage fee per intent stays in the contract (records are never deleted except on refund).
