# Known limitations

Honest list. Nothing here is claimed as working elsewhere.

## Product scope
- **No light-client verification.** Verdicts trust that ≥ 2 independent operators are not colluding. Cryptographic verification of RPC answers is out of scope (see `proven` in the research).
- **Hash-only checks can't prove `SAFE_TO_RETRY`.** Without the signed transaction (nonce, key, block hash), an unseen tx can only be `WAIT_AND_RECHECK`. This is by design.
- **"Pending in a mempool" vs "never received" is indistinguishable.** nearcore returns `UNKNOWN_TRANSACTION` for both (nearcore #15239 open; PR #15781 open and per-node only). Sentinel reports `UNKNOWN` and uses nonce and expiry to resolve it.
- **Cross-shard receipt tracing** uses the receipts returned with the transaction. `EXPERIMENTAL_receipt` / `EXPERIMENTAL_receipt_to_tx` lookups for receipts outside the tx result are not used.
- **Old transactions** need an archival provider. The default list includes FastNEAR archival (testnet). Without one, history beyond ~5 epochs is reported as not covered.
- **Operator independence is based on labels.** `SAFE_TO_RETRY` counts distinct `operator` values. The defaults are FastNEAR, dRPC and Intear, checked by DNS on 2026-11-11. An earlier default, `rpc.testnet.near.org`, turned out to be a CNAME to FastNEAR's infrastructure and was removed, because it would have counted FastNEAR twice. But a custom provider registered via `POST /api/v1/providers` (API key required) carries whatever label its registrant gives it, and an unlabelled one falls back to the host's last two DNS labels. Whether an aggregator such as dRPC routes to the same backend as another provider is not verified.
- **Mainnet is exercised read-only.** `pnpm test:live` runs 3 read-only mainnet checks (default mainnet providers reachable with chain_id mainnet from ≥ 2 independent operators; a real recent successful mainnet transaction, picked live from a final block, is `DO_NOT_RETRY`; an unknown hash is `WAIT_AND_RECHECK`). Everything that signs or moves funds (demos, contracts, live suites) ran on testnet only.

## Guard contract (`contracts/guard`)
- **Not audited.** Tested with 14 unit tests, a 13-check on-chain suite on a local sandbox (including a failed payment larger than the contract's own balance) (neard 2.14.0, protocol 88), and 11/11 live checks on testnet. Deployed to testnet as `guard.karios.testnet`; intended for testnet only.
- **Not locked.** The contract has no owner or upgrade method, but the account still holds its FullAccess key, so the key holder could redeploy. A production deployment should delete the account's keys after deploying.
- **Covers payments made through it.** A plain transfer an agent sends by another route is outside the guard; Sentinel's off-chain retry check covers those.
- **Storage fee:** 0.005 NEAR per recorded intent stays in the contract; records are only deleted when a transfer fails and is refunded.
- **Built with plain `cargo` + `--cfg near` in Docker (Rust 1.86)**, not `cargo near`, so building needs only Docker. The resulting wasm is verified on a real neard sandbox (code hash checked after deploy). It is not a reproducible (verifiable-source) build.

## Vault contract (`contracts/guard/vault`)
- **Not audited.** Tested with 19 Rust unit tests, a 14-check on-chain suite on the same local sandbox, and 10/10 live checks on testnet. Deployed to testnet as `vault.karios.testnet`; intended for testnet only.
- **The function-call-key flow was proven on the sandbox, not on testnet.** On testnet the live suite uses the owner's full-access key as the agent, because no key is generated there; the restricted-key command is documented for owners to run themselves.
- **Not locked.** Like the guard, the account keeps its FullAccess key, so the key holder could redeploy. A production deployment should delete the account's keys after deploying.
- **Covers money spent through it.** The limits apply to `spend`; an agent that also holds a full-access key, or other funds, is outside the vault.
- **Policy view is a snapshot.** `available_now` can be lower by the time `spend` lands (another spend, or a freeze); the contract re-checks every rule on-chain, so a stale view can only lead to a rejected spend, never an overspend.
- **Record fee:** 0.006 NEAR per spend is kept from the vault balance for the record's storage.

## Agent security checks (key check, payment preflight, safety score)
- **The payment check is advisory.** It mirrors `spend()` on the views it read; the contract re-checks on-chain. A view older than a 24-hour window reset can only make it say UNKNOWN, never a wrong ALLOWED (differential test: 50,000 random cases, 0 false ALLOWED).
- **The key check sees keys, not where they are stored.** It cannot tell a full-access key kept offline by the owner from one on the agent's machine, so any full-access key is flagged.
- **Function-call keys for other contracts are graded "review", not proven safe.** A function-call key cannot transfer NEAR itself, but Sentinel does not analyse what the target contract's methods can do.
- **Our demo agent `kariosr.testnet` keeps a full-access key** for simplicity, so the live key check shows FULL_ACCESS_PRESENT on purpose. The spend-only key flow is proven on the sandbox (see the Vault section).
- **The receiver scam check works on names, not reputation.** It compares a receiver with the known payees it is given (the Vault allowlist and owner in the payment check). It cannot know account age or history (that needs an indexer), and it cannot recognise a brand-new scam name that resembles nothing on the list.
- **One-letter differences can be real accounts.** With `bob1.near` known, `bob.near` is flagged (and `mike`/`mile`, `modem`/`modern`). That is deliberate: the check errs on the side of asking a human, and an exact match with a known payee is never flagged.
- **The safety score is a heuristic** over the policy's limits (any receiver, agent can pay itself, per-payment = daily, daily ≥ balance); it does not know what the receivers are.
- **Privacy is pseudonymisation.** Audit-log IPs are salted hashes, not anonymous data; whoever holds the salt can test a known IP. A rare low-level proxy error line (e.g. a failed TLS handshake) can still name the peer address.

- **The strict Content-Security-Policy is report-only for now.**
  - **Enforced today:** framing, `<base>`, form actions and plugins.
  - **Reported, not enforced:** the strict policy (`script-src 'self'`, `connect-src`, …). The dashboard has 0 violations, but the wallet connector runs wallet code in `srcdoc` iframes that inherit the page's CSP, so enforcement waits until owner wallet signing has been re-tested under it.
  - **COEP is not set on purpose:** it would block the wallets' cross-origin frames.
  - Details are in [SECURITY.md](../SECURITY.md#web-security-headers).

## Optional account verification
- **MyNearWallet only** (NEP-413 sign-message redirect). Other wallets (Meteor, HOT, Ledger) are not wired; no wallet library is bundled.
- **A label, not authentication.** It shows which account the dashboard user is; it grants no extra rights and creates no session. Protected endpoints still use API keys.
- The signature check accepts both NEP-413 payload forms (with and without `callbackUrl`), because wallets differ. Nonce and recipient are always bound.
- Clicked through with a real wallet: not yet. The server-side verification is covered by tests with real ed25519 signatures, and the browser flow by E2E tests with a stubbed wallet page.

## Engineering
- **MCP server** is verified with the official MCP client over stdio (including a live testnet call) and from a live MCP client session (`claude mcp add`).
- **Single process, single SQLite file.** No horizontal scaling or shared rate-limit store. Fine for one instance; multiple replicas would each probe providers and keep separate history.
- **Benchmarks** are snapshots from one location (the operator's server), not a ranking of providers. Scores below 30 samples are flagged insufficient.
- **The SDK is ESM-only** (Node ≥ 20.19 can `require()` it). It's built with plain `tsc` (no bundler), so the build has no native-binary dependencies.
- **Not published to npm.** `@near-sentinel/sdk` is npm-ready (`exports`, types) but is used via the workspace.
- **No OpenTelemetry.** Prometheus metrics and structured pino logs only.
- **No API-key management UI.** Keys are configured as SHA-256 digests in the environment.
- **Dashboard E2E uses an installed Google Chrome** (`channel: "chrome"`) by default rather than Playwright's downloaded browser. Set `PW_CHANNEL` to change this.
- **`node:sqlite` prints an "experimental" warning on Node 22.** It is suppressed with `--no-warnings=ExperimentalWarning` in the start scripts.

## Not yet done (as of 2026-11-11)
- (Done 2026-11-11: the Vultr deployment runs live at https://64-177-60-105.sslip.io on a 1 GB server.) It is a single small instance: no redundancy, and probe history lives on that one server.
- (Done 2026-11-11: `pnpm demo:testnet` and `pnpm demo:critical` ran on real testnet; see the README Demo section.) Re-running them needs your own testnet sender and receiver accounts. Its safety gates (testnet only, amount cap, explicit confirmation) are covered by tests; the simulated demo (`pnpm demo`) needs no wallet.
