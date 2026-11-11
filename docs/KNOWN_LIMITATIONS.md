# Known limitations

Honest list. Nothing here is claimed as working elsewhere.

## Product scope
- **No light-client verification.** Verdicts trust that ≥ 2 independent operators are not colluding. Cryptographic verification of RPC answers is out of scope (see `proven` in the research).
- **Hash-only checks can't prove `SAFE_TO_RETRY`.** Without the signed transaction (nonce, key, block hash), an unseen tx can only be `WAIT_AND_RECHECK`. This is by design.
- **"Pending in a mempool" vs "never received" is indistinguishable.** nearcore returns `UNKNOWN_TRANSACTION` for both (nearcore #15239 open; PR #15781 open and per-node only). Sentinel reports `UNKNOWN` and uses nonce and expiry to resolve it.
- **Cross-shard receipt tracing** uses the receipts returned with the transaction. `EXPERIMENTAL_receipt` / `EXPERIMENTAL_receipt_to_tx` lookups for receipts outside the tx result are not used.
- **Old transactions** need an archival provider. The default list includes FastNEAR archival (testnet). Without one, history beyond ~5 epochs is reported as not covered.
- **Operator independence is based on labels.** `SAFE_TO_RETRY` counts distinct `operator` values. The defaults are labelled correctly (FastNEAR, dRPC, near.org), but a custom provider registered via `POST /api/v1/providers` (API key required) carries whatever label its registrant gives it, and an unlabelled one falls back to the host's last two DNS labels. Whether an aggregator such as dRPC routes to the same backend as another provider is not verified.
- **Mainnet defaults exist but were not exercised by the test suite.** All live tests ran on testnet. Mainnet use is supported by configuration only.

## Guard contract (`contracts/guard`)
- **Not audited.** Tested with 14 unit tests, a 12-check on-chain suite on a local sandbox (neard 2.14.0, protocol 88), and 11/11 live checks on testnet. Deployed to testnet as `guard.karios.testnet`; intended for testnet only.
- **Not locked.** The contract has no owner or upgrade method, but the account still holds its FullAccess key, so the key holder could redeploy. A production deployment should delete the account's keys after deploying.
- **Covers payments made through it.** A plain transfer an agent sends by another route is outside the guard; Sentinel's off-chain retry check covers those.
- **Storage fee:** 0.005 NEAR per recorded intent stays in the contract; records are only deleted when a transfer fails and is refunded.
- **Built with plain `cargo` + `--cfg near` in Docker (Rust 1.86)**, not `cargo near`, so building needs only Docker. The resulting wasm is verified on a real neard sandbox (code hash checked after deploy). It is not a reproducible (verifiable-source) build.

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
- The Vultr deployment (`deploy/vultr`) is validated locally but not yet run on a real server.
- The real-testnet demo run (`pnpm demo:testnet -- --i-confirm`) needs your own testnet sender and receiver accounts. Its safety gates (testnet only, amount cap, explicit confirmation) are covered by tests; the simulated demo (`pnpm demo`) needs no wallet.
