# Contributing

```bash
pnpm install
pnpm build && pnpm typecheck && pnpm test     # must pass before any PR
pnpm test:live                                 # if you touched RPC behaviour (read-only, public testnet)
pnpm start & pnpm test:e2e                     # if you touched the dashboard or API serving
```

Rules:
1. **Never weaken a safety invariant without a test.** `SAFE_TO_RETRY` must stay proof-based, and unknown must never become safe. `packages/sdk/test/retry.test.ts` encodes the table; extend it.
2. **Every new failure shape needs a fixture.** Capture the real RPC response (redact nothing secret; RPC responses are public), add it under `packages/sdk/test/fixtures/` with provenance in `fixtures/README.md`, and test against it. Synthetic variants must be labelled `synthetic` in the test.
3. **No hidden retries in the transport.** One request = one observation.
4. **Docs describe what runs.** If you can't demonstrate it, list it in `docs/KNOWN_LIMITATIONS.md` instead.
5. **No secrets in the repo.** `.env` files are git-ignored; `.env.example` files hold placeholders only.

Code style: TypeScript strict, ESM, no `any` in public types.
