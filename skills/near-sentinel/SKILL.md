---
name: near-sentinel
description: >-
  Read-only NEAR payment safety checks (holds no keys). Use when: (1) an RPC call timed out or returned
  TIMEOUT_ERROR or an unclear result, (2) deciding whether to resend, re-sign or retry a NEAR transfer or
  payment, (3) checking whether a transaction landed, can still land, or can never land, (4) paying from a
  Sentinel Vault allowance or through a Sentinel Guard intent. Prevents paying twice. Triggers on NEAR retry,
  resend, timeout, "did it land", or duplicate-payment tasks.
license: MIT
compatibility: Requires the near-sentinel MCP server (Node 22.16+, built from this repo) or HTTPS access to its REST API.
---

# NEAR Sentinel: check before you pay again

An RPC timeout does not mean the payment failed. It may already have executed, or may still land.
Signing a **new** transaction for the same payment can move the money twice. Follow these steps.

## 1. After a timeout, network error or unclear result

1. Keep the signed transaction you sent. Do **not** sign a new one yet.
2. Call `check_retry_safety`. Prefer `signedTransactionBase64` (the bytes you sent, which contain no private key);
   otherwise pass `transactionHash` + `senderAccountId`.
3. Act on the verdict:

| Verdict | What you do |
|---|---|
| `DO_NOT_RETRY` | Treat the payment as done. Do not pay again. |
| `WAIT_AND_RECHECK` | It may still land. Wait and call `check_retry_safety` again, or re-broadcast the **identical** signed bytes. Never sign new ones. |
| `SAFE_TO_RETRY` | Proven that the original can never land. You may sign a new transaction. |
| `MANUAL_REVIEW_REQUIRED` | Part of it executed, or providers disagree. Stop and escalate to a human. |

Unknown is never reported as safe. If the tool itself fails, treat the result as unknown: wait, do not re-sign.

## 2. Paying from a Sentinel Vault allowance

1. Call `check_spend_allowance` (`contractId`, `ownerId`, `agentId`) before `spend`.
2. Never pay more than `availableNow`, and never pay a receiver outside `allowed_receivers` (when the list is not empty).
3. `FROZEN`, `EXHAUSTED`, `NO_POLICY` or `UNKNOWN` mean: do not pay.
4. Use a fresh `intent_id` per payment. Re-sending `spend` with the **same** `intent_id` cannot pay twice.

## 3. Paying through Sentinel Guard

1. Call the guard's `pay(intent_id, receiver_id)`; on any retry reuse the **same** `intent_id`.
   A repeat is rejected on-chain (`DUPLICATE_INTENT`) and refunded.
2. To confirm, call `check_intent` (`contractId`, `payerId`, `intentId`): `PAID`, `PENDING`, `NOT_RECORDED`.
3. Never pay the same intent by another route.

## Connect

**MCP (stdio, read-only):** build the repo (`pnpm install && pnpm build`), then register

```
command: node
args:    ["/abs/path/to/near-sentinel/packages/mcp/dist/server.js"]
env:     NEAR_SENTINEL_NETWORK=testnet
```

Tools: `check_retry_safety`, `check_intent`, `check_spend_allowance`, `inspect_transaction`, `trace_receipts`,
`diagnose_submission_error`, `provider_health`.

**REST fallback** (live testnet instance, no key needed):

- `POST https://64-177-60-105.sslip.io/api/v1/transactions/retry-check` with `{"transactionHash","senderAccountId"}` or `{"signedTransactionBase64"}`
- `GET https://64-177-60-105.sslip.io/api/v1/intents?contract=&payer=&intent=`
- `GET https://64-177-60-105.sslip.io/api/v1/allowance?contract=&owner=&agent=`

Sentinel never signs or sends anything. Signing stays with your wallet or your own agent.
