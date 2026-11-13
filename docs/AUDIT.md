# Audit report (2026-11-13)

**Live re-audit after deploying the fixes (`582bec3`):**
- browser tests 58/59 on the full run, and the 1 transient (a provider or rate-limit hiccup) passed on re-run;
- receiver checks 15/15, API checks 36/36, walkthrough 15/15;
- Lighthouse mobile 89 and desktop 95 (accessibility, best practices and SEO 100, CLS 0);
- OWASP ZAP 0 failures.

Everything below was run against the **live** instance (https://64-177-60-105.sslip.io) or the production Docker image, with real testnet data. Each audit lists its result, what was fixed, and what is left on purpose.

## 1. Real transactions on testnet

Sentinel's payment check predicted each outcome before the real `spend` was sent to `vault.karios.testnet`. **10/10 predictions matched the contract.** Payments 2 and 3 were refused for the 24-hour limit because an earlier run had already used most of it, and Sentinel predicted that from the rolling window.

| Case | Sentinel predicted | Contract did | Transaction |
|---|---|---|---|
| pay 0.005 to the real payee | `ALLOWED` | `PAID` | [`48zfyhrR…`](https://testnet.nearblocks.io/txns/48zfyhrRM3Ga7V1rb3wkunSJRdQREsfUvR8ii2Arv694) |
| same payment id again (retry) | `DUPLICATE_INTENT` | `DUPLICATE_INTENT` | [`EzWungQJ…`](https://testnet.nearblocks.io/txns/EzWungQJbxraidMC7HzheWUBJifpb1m3Zh7U3gJsvVeB) |
| prompt-injected lookalike kari0s | `NOT_ALLOWED_RECEIVER` | `NOT_ALLOWED_RECEIVER` | [`H6K1eoLd…`](https://testnet.nearblocks.io/txns/H6K1eoLdbZDbQk5EgfLyTPWEtsoNiFUTM2b174axmMY7) |
| 0.02, over the per-payment limit | `OVER_PER_PAYMENT_LIMIT` | `OVER_PER_PAYMENT_LIMIT` | [`7EM8NG94…`](https://testnet.nearblocks.io/txns/7EM8NG94fRhNN3xowyTGn6h5sntuwF2EuMdZK7MMAWtq) |
| pay the vault itself | `INVALID_RECEIVER` | `INVALID_RECEIVER` | [`BacmG4Bu…`](https://testnet.nearblocks.io/txns/BacmG4BuMRiQDDfrn8wRbhEcKW9b5gUmeNgnDoMTGgeC) |
| amount 0 | `INVALID_AMOUNT` | `INVALID_AMOUNT` | [`7272c3DX…`](https://testnet.nearblocks.io/txns/7272c3DXBokzrtX3LmN24HGmkGWuB6FrLVUShZoQGdWi) |
| pay 0.01 (2nd) | `OVER_DAILY_LIMIT` | `OVER_DAILY_LIMIT` | [`BB8ZfXKA…`](https://testnet.nearblocks.io/txns/BB8ZfXKADYFnvGgJyz1wPtPuWrtAYcanZygziRQBjEAa) |
| pay 0.01 (3rd, day total 0.025) | `OVER_DAILY_LIMIT` | `OVER_DAILY_LIMIT` | [`HsTV5ymf…`](https://testnet.nearblocks.io/txns/HsTV5ymfkbK7ZJPXSe3DtaSuUhAJWuPAwBf46LdvuL5o) |
| pay 0.01 more (day total 0.035) | `OVER_DAILY_LIMIT` | `OVER_DAILY_LIMIT` | [`4jPXMBba…`](https://testnet.nearblocks.io/txns/4jPXMBba1xg65p4Yhg2Ln5pCBzay6ZbxTzvDwmX2FbwW) |
| pay 0.001 while frozen | `FROZEN` | `FROZEN` | [`67nYeiTw…`](https://testnet.nearblocks.io/txns/67nYeiTwNwY3sN4VffNtkWEpjMbxBng8qM8JqdK4oNN7) |

The real 0.005 NEAR payment then got `DO_NOT_RETRY` from the "did it land?" check. **Guard (pay once per intent), real money:**

| Step | Result | Transaction |
|---|---|---|
| before paying: intent status | NOT_RECORDED |  |
| guard pay 0.005 to the payee | PAID | [`BwuNp2Vq…`](https://testnet.nearblocks.io/txns/BwuNp2VqupnDLBjiJmjWqT7R1MQrQqVnX1DP8mnQLCo3) |
| after paying: intent status | PAID |  |
| did it land? (retry-check on the pay tx) | DO_NOT_RETRY |  |
| same intent again (a retry) | DUPLICATE_INTENT, deposit refunded | [`Av16fn4B…`](https://testnet.nearblocks.io/txns/Av16fn4BBFEi6p7gaiqg7dL45nLGqpgftqXNPAbSEUqL) |
| after the retry: still paid once | PAID |  |

All transactions were testnet only, between the owner's own accounts (`karios.testnet` → `kariosr.testnet`). The remaining test allowance was withdrawn ([`CYUKqwi6…`](https://testnet.nearblocks.io/txns/CYUKqwi6Rqdg78bh862cP41ufCHMXqA7JTruWaPDaprw)). An earlier run on 2026-11-12 also matched 10/10 (see JUDGING.md).

## 2. Automated audits

| Audit | Tool | Result |
|---|---|---|
| Accessibility, best practices, SEO | Lighthouse 12 | **100 / 100 / 100** (mobile and desktop) |
| Performance | Lighthouse 12 (live, after the fixes) | Mobile **78 → 89**, desktop **93 → 95**. Layout shift (CLS) on mobile **0.368 → 0** |
| Accessibility (WCAG 2.1 AA) | axe-core on all 8 pages, in the browser suite | 0 serious or critical issues |
| Web security, passive | OWASP ZAP baseline (re-run live after the fixes) | **0 failures**, 62 checks passed. The remaining low notes are expected from the staged CSP rollout or accepted with a reason (see below) |
| API fuzzing | Schemathesis on the OpenAPI spec (28 operations, 166 generated cases) | No crashes. The only 5xx answers are the intended `503 PROTECTED_ENDPOINTS_DISABLED` when no admin key is configured. The rest are OpenAPI-completeness notes, not bugs |
| Dependencies | `pnpm audit` | No known vulnerabilities |
| Secrets | secrets gate (runs first in `pnpm test`) | No keys, seed phrases or `.env` files in the repo |
| Lookalike detector | 20,000 randomized cases | 0 false alarms (exact, sub-account, other network), 0 misses, about 0.05 ms per check |
| Payment check vs contract | 50,000 randomized cases against a model of `spend()` | 0 wrong ALLOWED, 0 wrong BLOCKED, 0 wrong codes |
| Code review | 2 independent reviews of the receiver check, 1 of agent security | Every finding fixed before merge |

## 3. UI/UX audit (Nielsen heuristics + WCAG 2.2 basics, all pages at 390 / 768 / 1360 px)

**Fixed:**

| Severity | Issue | Fix |
|---|---|---|
| High | Inspect: an example's verdict appeared below the fold with no feedback, and was not announced to screen readers | The loading state and the verdict scroll into view (instant with reduced motion), inside an `aria-live` region |
| High | Hidden tooltips still took space, so the Guard and Vault cards scrolled sideways (up to 120 px on phones) | Closed tooltips are `display: none` and capped to the screen width |
| Medium | Layout shift on first visit: the optional verify banner appeared only after the provider list loaded | The banner renders at once; its button waits for the network |
| Medium | No one-click allowed payment; the demo agent's role was unclear | "Try an allowed payment" next to "Try a scam lookalike"; clearer demo-account text |
| Medium | Tour step "Look up the Guard contract" landed at the top of Inspect | It deep-links to the Guard tool |
| Medium | "Payment id" and "Intent ID" used for the same thing | One term: "Intent ID" |
| Medium | Per-provider "POLICY" / "KEYS" badges unexplained | A help icon on the Answer column |
| Medium | Start said "4 / 4 providers" while Overview counts operators | Start shows "(3 operators)" next to it |
| Low | Double period in failure explanations | Fixed in the SDK |
| Low | "your recent inspections" were really server-wide | Reworded |
| Low | "tx" and "explorer" link names were not descriptive | Accessible names added, which still contain the visible text (WCAG 2.5.3) |
| Low | In the live demo, the naive agent that got lucky looked as safe as the guarded one | It is shown amber with "Got lucky: it signed 2 payments" |
| Low | Fingerprinted assets were revalidated on every visit | Cached for a year as immutable; `index.html` is still revalidated |

| Low | Ctrl+K palette focus ring overlapped the dialog border | Drawn inside the input; still visible (WCAG 2.4.7) |
| Low | Provider name "fastnear-archival" was cut to "fastnear-archi…" | Long names wrap at the hyphen; the full name is in a tooltip |

## 4. OWASP ZAP warnings: fixed or accepted with a reason

| ZAP warning | Status |
|---|---|
| CSP: failure to define a directive with no fallback (10055) | **Fixed.** The enforced CSP now sets `base-uri`, `form-action` and `object-src` besides `frame-ancestors` |
| Strict CSP | **Staged** (OWASP CSP Cheat Sheet). The strict policy is sent as `Content-Security-Policy-Report-Only`, and browser tests prove 0 violations on every page and main flow and that the wallet picker still loads. Enforcement follows the owner's wallet re-test |
| Cross-Origin-Embedder-Policy missing (90004) | **Accepted.** `require-corp` would block the wallets' cross-origin frames and icons; nothing needs cross-origin isolation. `Cross-Origin-Opener-Policy: same-origin-allow-popups` and `Cross-Origin-Resource-Policy` are set |
| Storable/cacheable content, re-examine Cache-Control (10049, 10015) | **Addressed.** Fingerprinted assets are `immutable` for a year, `index.html` is `no-cache`, API responses are `no-store` |
| CSP Report-Only header found (10038), CSP wildcard directive (10055) | **Expected during the staged rollout.** The enforced policy deliberately leaves `script-src`, `connect-src` and others to the Report-Only policy until owner wallet signing has been re-tested under it |
| Modern web application (10109) | Informational only (a single-page app) |

## 5. Re-run it yourself

`pnpm verify` runs the build, 444 unit and integration tests, 10 live tests, 59 browser tests and the contract suites. The real-transaction checks need the owner's testnet key and are not part of `pnpm verify`.
