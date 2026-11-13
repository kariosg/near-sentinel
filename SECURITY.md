# Security policy

## Model

NEAR Sentinel is **read-only**:
- It never asks for, receives, stores or logs private keys or seed phrases.
- It never signs or submits transactions. A `signedTransactionBase64` input carries a *signature*, not a key, and is only decoded to read the hash, nonce, public key and block hash.
- `compareProviders` accepts only an allow-list of read methods. `send_tx` and `broadcast_tx_*` are rejected (tested).

The only code in this repository that signs anything is:
- `examples/agent-demo` (the real-testnet demo), and
- `contracts/guard/scripts` (deploy + live test of the guard contract, and the local sandbox suite).

They sign with keys the operator places in **git-ignored** `.env` files (`examples/agent-demo/.env`, `contracts/guard/.env`). Every script refuses to run unless the RPC reports `chain_id=testnet` (or `sandbox` for the local suite), defaults to a dry run, needs `--i-confirm` to send anything, and never prints a key. The API's own `.env` (loaded into the Docker container) must never hold keys.

**Secrets gate:** `pnpm test` starts with `scripts/check-secrets.mjs`, which fails if any file git would commit contains a NEAR secret key, a seed-phrase-like word list, or a `.env` file. It prints only file and line, never the match.

**Guard contract:** no owner, no admin methods, no upgrade method in the code. On testnet the contract accounts still hold the deployer's full-access key, so they are not locked (the Agent keys tool shows this; see [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)). The callback is `#[private]` (verified on-chain). See [contracts/guard/README.md](contracts/guard/README.md).

**Optional account verification (NEP-413):** server-issued 32-byte nonces, single use, 5-minute expiry, burned on the first attempt; recipient and message bound; ed25519 verified server-side; the key must be a FullAccess key of the account on-chain. It creates no session and grants no rights.

**Safety of verdicts:** "unknown" is never converted into "safe". `SAFE_TO_RETRY` for an unseen transaction requires independent proof from ≥ 2 operators (see [docs/architecture/STATE_MAPPING.md](docs/architecture/STATE_MAPPING.md)).

## Controls implemented (and where they are tested)

| Control | Where | Test |
|---|---|---|
| SSRF guard: https only, no credentials in URLs, port allow-list, blocks private / loopback / link-local / metadata / CGNAT / IPv4-mapped / decimal-hex IPs and internal hostnames | `packages/sdk/src/ssrf.ts` | `ssrf.test.ts`, API SSRF test |
| DNS-rebinding defence: the IP is re-validated at **connect time** | `createGuardedFetch` | `ssrf.test.ts` (hostname → loopback blocked; reason asserted) |
| Redirects refused | `rpc.ts` (`redirect: "error"`) | — |
| Response size cap (default 8 MiB; streamed, aborts early) | `rpc.ts` | `transport.test.ts`, live test |
| Per-request timeouts and caller cancellation | `rpc.ts` | `transport.test.ts` |
| Untrusted provider answers rejected (wrong hash / malformed) | `sentinel.ts` `validateTxResult` | `sentinel.test.ts` |
| Custom providers must serve the configured chain | `POST /api/v1/providers` | API test (mainnet endpoint → 422) |
| Input validation (strict zod; unknown fields rejected) | `apps/api/src/app.ts`, `packages/sdk/src/validation.ts` | API tests |
| API keys stored as SHA-256 digests, constant-time compare, fail closed | `apps/api/src/auth.ts` | API tests |
| Audit log of protected operations (including failures) | `audit_log` table | API test |
| Rate limiting; `X-Forwarded-For` ignored unless `TRUST_PROXY=1` | Fastify rate-limit | API test (spoofing does not bypass) |
| Secrets redacted from logs (`authorization`, `x-api-key`, cookies) | pino redact | Verified: key appeared 0 times in a live log |
| SQL injection: prepared statements only | `apps/api/src` | code review |
| Metrics not exposed publicly (separate 127.0.0.1 listener; not published by Compose) | `metrics.ts`, `docker-compose.yml` | Verified in Docker |
| Container runs as non-root `node` | `Dockerfile` | Verified |
| Event streams capped per client IP (10) and in total (200) | `/api/v1/events` | API test |
| Request body limit 2.5 MB (413) | Fastify `bodyLimit` | API test |
| NEP-413 verification: forged / wrong-key / reused-nonce / unknown-nonce / wrong-recipient / FunctionCall-key all rejected | `apps/api/src/identity.ts` | API tests, E2E (forged wallet callback) |
| Guard contract: duplicate intent, private callback, input validation, concurrent race | `contracts/guard` | Rust unit tests + on-chain sandbox suite |
| No secrets in the repository | `scripts/check-secrets.mjs` | runs first in `pnpm test`; self-tested with planted fake key and seed line |
| Dependency scanning | `pnpm audit` | "No known vulnerabilities found" (2026-11-10) |

## Web security headers

The headers are defined once, in `apps/api/src/security-headers.ts`, and sent on every response. They are unit- and browser-tested. The TLS proxy adds HSTS.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` (enforced) | `frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, plus `upgrade-insecure-requests` over HTTPS | No framing (clickjacking), no `<base>` or form hijacking, no plugins. Cannot break scripts or wallets |
| `Content-Security-Policy-Report-Only` | strict: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; …` | Staged rollout (OWASP CSP Cheat Sheet). The dashboard produces **0 violations** on every page and main flow (browser-tested). It is enforced once owner wallet signing has been re-tested under it, because wallet code runs in `srcdoc` iframes that inherit the page's CSP |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | Isolates the window from cross-origin openers and keeps wallet popups working |
| `Cross-Origin-Resource-Policy` | `same-origin` (API), `same-site` (pages, assets) | Stops other sites embedding API responses |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (at the TLS proxy) | HTTPS only |
| `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | `DENY`, `nosniff`, `no-referrer`, camera/mic/geolocation/payment off | Defence in depth |
| `Cross-Origin-Embedder-Policy` | **not set, on purpose** | `require-corp` would block the wallets' cross-origin frames and icons. Nothing here needs cross-origin isolation |

## Agent security (OWASP Top 10 for Agentic Applications, 2026)

How Sentinel maps to the [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/). The core idea: an agent's spending limits live **on-chain**, not in its prompt, so a hijacked or confused model still cannot exceed them.

| Risk | What Sentinel does |
|---|---|
| **ASI01 Agent Goal Hijack** | Vault limits are enforced by the contract: per-payment cap, 24-hour cap and receiver allowlist. A prompt-injected agent can only fail against them. Spend preflight (`GET /api/v1/spend-preflight`, MCP `preflight_spend`) runs the same checks before signing and says which rule would block the payment. Its `action` (SIGN / ASK_HUMAN / REFUSE) also folds in the receiver check, and the SDK's `guardedSpend` enforces it in code, so the decision to sign does not depend on the model obeying instructions. Attack demo: `pnpm demo:injection` ([transcript](docs/injection-demo.md)). |
| **ASI02 Tool Misuse and Exploitation** | All MCP tools are read-only and carry `readOnlyHint` annotations; none can sign or send. `compareProviders` accepts only an allow-list of read methods. Guard enforces pay-once per intent ID, so a retried or looped tool call cannot pay twice. |
| **ASI03 Identity and Privilege Abuse** | Agent key audit (`GET /api/v1/agent-keys`, MCP `audit_agent_keys`) flags full-access keys and recommends a function-call key limited to the vault's `spend` method. The Vault checks `predecessor_account_id` (the direct caller), not the signer, so another contract cannot spend on an agent's behalf. The owner can freeze an agent at any time (kill switch). |
| **ASI04 Agentic Supply Chain** | Lockfile-pinned dependencies (`--frozen-lockfile` in the Docker build), `pnpm audit` before release, and a secrets gate that runs first in `pnpm test`. The Guard contract has no owner, admin or upgrade method (on testnet its account is not yet locked). |
| **ASI05 Unexpected Code Execution** | **Not covered.** Sentinel runs no agent-generated code; sandboxing the agent itself is the host's job. |
| **ASI06 Memory & Context Poisoning** | **Not covered.** Sentinel keeps no agent memory; it cannot see or clean an agent's context. |
| **ASI07 Insecure Inter-Agent Communication** | **Not covered.** Sentinel is not a messaging layer between agents. |
| **ASI08 Cascading Failures** | Multi-provider consensus: `SAFE_TO_RETRY` needs proof from at least 2 independent operators, and "unknown" is never turned into "safe". When providers disagree or are missing, Sentinel says so instead of guessing. |
| **Receiver scam check** (part of ASI01/ASI09) | `check_receiver` / `GET /api/v1/receiver-check`, also inside every payment check: a lookalike of a known payee or a poisoned raw address is DANGER, a missing named account is NOT_FOUND. Name-based heuristics, not a reputation database. |
| **ASI09 Human-Agent Trust Exploitation** | Verdicts are plain-language with the evidence behind them (per-provider answers, block heights). Allowance safety score shows how much an agent could still spend. |
| **ASI10 Rogue Agents** | Vault freeze stops a misbehaving agent immediately, on-chain. The 24-hour cap bounds the worst case before anyone notices. |

Limits of this mapping: an empty Vault allowlist allows any receiver, and the key audit only reports; it cannot change keys. Both are the owner's choice.

## Privacy

What the API and dashboard store, for how long, and what they never store: see [docs/PRIVACY.md](docs/PRIVACY.md). In short: no keys, no cookies, no analytics; audit-log IPs are hashed and kept 30 days.

## Reporting a vulnerability

Please open a private security advisory on the repository, or contact the maintainer listed on the repository page. Do not open public issues for vulnerabilities. Include reproduction steps, affected version and impact.
