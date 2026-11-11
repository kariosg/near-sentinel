# State and verdict mapping

Derived from `packages/sdk/src/outcome.ts` (state) and `packages/sdk/src/retry.ts` (verdict). Tests: `test/outcome.test.ts`, `test/retry.test.ts`, `test/sentinel.test.ts`.

## Inputs Sentinel reads (all read-only)

| RPC call | When | Why |
|---|---|---|
| `EXPERIMENTAL_tx_status` with `wait_until: "NONE"` | Always, on every provider in parallel | `NONE` never blocks. Longer waits time out differently per provider: nearcore 408 `TIMEOUT_ERROR` after 10–13 s, dRPC 408 `code 30` after ~2 s, sometimes no answer. The `EXPERIMENTAL_` name is used because dRPC testnet rejects the stabilised `tx_status`. |
| `query view_access_key` at `finality: final` | Only if not found **and** the nonce and key are known (signed tx supplied) | Has the nonce been consumed? A missing key comes back as a *successful* result with `result.error: "... does not exist while viewing"`. |
| `block` by the tx's `block_hash` | Same | Does this node hold the history window? Is the tx expired (`final_height − block_height > transaction_validity_period`)? |
| `EXPERIMENTAL_tx_status` again | Same, **after** the two reads above | "Not found" must be observed *after* "nonce consumed", on the same node. |
| `EXPERIMENTAL_protocol_config` | Once (cached) | `transaction_validity_period` (86,400 blocks on testnet as of 2026-11-09). |

Every answer is validated before it counts. A "found" result must carry the requested hash and a well-formed outcome; otherwise it is downgraded to `MALFORMED`.

## Application state (`TxState`)

Computed from the found result with the highest `final_execution_status` across providers.

| Condition (non-refund receipts = predecessor ≠ `system`) | `TxState` |
|---|---|
| `final_execution_status` ∈ {`NONE`, `INCLUDED`, `INCLUDED_FINAL`}, or any receipt outcome not yet present / `Unknown` | `INCLUDED` |
| All non-refund receipts `SuccessValue`/`SuccessReceiptId` | `EXECUTED_SUCCESS` |
| All non-refund receipts `Failure` | `EXECUTED_FAILURE` |
| Some succeeded and some failed | `PARTIALLY_COMPLETED` |
| Not found anywhere, and `SAFE_TO_RETRY` was proven | `EXPIRED_OR_UNRESOLVED` |
| Not found, not proven | `UNKNOWN` |

- `finalized = (final_execution_status === "FINAL")` is reported separately, rather than as a state.
- `DOWNSTREAM_FAILURE_MASKED` is a diagnostic raised when the top-level status is success but a receipt failed (a callback swallowed it).
- **Not used:** `CREATED`, `SUBMITTED` and `PENDING` from the original brief. A read-only observer cannot see a transaction before a node has it, and nearcore answers `UNKNOWN_TRANSACTION` for both "in a mempool" and "never received" (nearcore #15239, open). Reporting them would invent states.

## Retry verdict

| Evidence | Verdict | Confidence |
|---|---|---|
| Found; executed outcomes conflict between providers | `MANUAL_REVIEW_REQUIRED` | high |
| Found; `INCLUDED` | `DO_NOT_RETRY` (re-check in ~3 s) | high |
| Found; `EXECUTED_SUCCESS` | `DO_NOT_RETRY` | high |
| Found; `PARTIALLY_COMPLETED` | `MANUAL_REVIEW_REQUIRED` | high |
| Found; `EXECUTED_FAILURE` (atomic, no side effects), the same failed outcome at `FINAL` on ≥ `minIndependentOperators` distinct operators | `SAFE_TO_RETRY` (fix the cause first) | high |
| Found; `EXECUTED_FAILURE` but not yet `FINAL` on enough distinct operators | `WAIT_AND_RECHECK` (re-check in ~3 s) | medium |
| Not found; no provider gave a definite answer | `WAIT_AND_RECHECK` | low |
| Not found; hash only (no nonce) | `WAIT_AND_RECHECK` | medium |
| Not found; signed tx supplied; ≥ `minIndependentOperators` (default 2) **distinct operators** each show, on the same node: window covered **and** (nonce consumed **or** expired, using that node's own height for the tx's `block_hash`) **and** not found on the second lookup | `SAFE_TO_RETRY` | high |
| Same proof, but nonce / key / block hash were passed as separate SDK fields instead of the signed tx (not bound to the hash) | `MANUAL_REVIEW_REQUIRED` | medium |
| Not found; some node shows the tx can't land (nonce consumed / expired / key missing) but not enough independent proof | `MANUAL_REVIEW_REQUIRED` | medium |
| Not found; nonce unused and not expired | `WAIT_AND_RECHECK` (with remaining blocks and measured ETA) | high |
| Not found; nonce could not be read from any provider | `WAIT_AND_RECHECK` | low |

Rules that are tested explicitly:
- An unknown (`null`) window coverage never counts as proof.
- Two hostnames from the same operator count as one witness.
- A missing access key is **never** proof (it could be re-added). It escalates to manual review.
- Exactly at the validity boundary is **not** expired.
- A block answer only counts if its hash is the tx's `block_hash`; each provider's expiry uses its own height for that block.
- The validity period read from a provider is never taken below the protocol default (86,400 blocks).
- No ETA in minutes is shown unless block time was measured.
- Re-broadcasting the **identical** signed bytes is reported as duplicate-safe whenever the tx might still land. On NEAR the same bytes have the same hash and nonce and execute at most once.

## Provider agreement

| Value | Meaning |
|---|---|
| `UNANIMOUS` | Every answering provider found the tx with the same outcome digest (or all said not found). |
| `CONSISTENT_WITH_LAG` | Some providers lack a tx others have, or report lower finality. Explained by indexing lag or GC'd history, not misbehaviour. |
| `CONFLICTING` | Two providers report *executed* outcomes with different digests. |
| `INSUFFICIENT` | No provider answered at all. |

The digest covers the status, receipt ids, receipt statuses, tokens burnt and child ids. It ignores gas profiles and metadata, which legitimately differ between nodes.
