# Manual test with a real wallet (2026-11-13)

A team tester connected their own testnet wallet through NEAR Connect on the live dashboard (https://64-177-60-105.sslip.io) and approved each transaction in the wallet. Sentinel only prepared and previewed each one. Testnet only; contract `vault.karios.testnet`, agent `kariosr.testnet`. This is the [TESTING.md → B](TESTING.md#b-with-your-own-testnet-wallet-optional-about-10-minutes) flow, run end to end.

## Real transactions

| # | Action | Transaction | Checked in the dashboard | Checked on-chain (`get_policy`) |
|---|---|---|---|---|
| 1 | `set_policy`: 0.01 NEAR per payment, 0.02 per 24 h, any receiver, deposit 0.05 NEAR | [`9QQMcG6i…`](https://testnet.nearblocks.io/txns/9QQMcG6iZN745J4QzG7gJVfGUWFAuTzRFr9sgogtESfR) | "set_policy sent" + link; Check allowance `ACTIVE`, 0.01 available, 4/4 providers agree | limits exact, balance 0.04839 (the rest paid storage) |
| 2 | `set_frozen(true)` | [`EJvUd8x8…`](https://testnet.nearblocks.io/txns/EJvUd8x8aRcCgcYvS4SoPLTMq7pFVcX39UH9YoWtsGrH) | `FROZEN`; payment check `BLOCKED · FROZEN`, agent action `REFUSE` | `frozen: true`, available 0 |
| 3 | `set_frozen(false)` | [`93xZCmtP…`](https://testnet.nearblocks.io/txns/93xZCmtPGNNpEzosmoH7RXA7bMoKHPmisEKCmdbRKfkP) | `ACTIVE` again | `frozen: false`, available 0.01 |
| 4 | `withdraw` Max (0.04839 NEAR) | [`E2NgiPZ2…`](https://testnet.nearblocks.io/txns/E2NgiPZ25UVrMfutFZKApNh6pVbF99ZUoCydkXDa6PMi) | balance back in the wallet | vault balance 0 |

The whole run cost the wallet about 0.0026 NEAR (gas and storage).

## Refused before the wallet opens (no transaction)

| Try | Shown |
|---|---|
| Per payment 0.5 > per 24 h 0.1 | "The per-payment limit must not be higher than the 24-hour limit." |
| Deposit 0.05 from a wallet with 0 NEAR | "Your wallet has 0 NEAR available. Keep about 0.01 NEAR for gas, so deposit less." |
| Freeze an agent this owner never funded | "… has no allowance for kariosr.testnet. You can only freeze allowances you funded as the owner." |
| Withdraw for an agent this owner never funded | "… You can only withdraw from allowances you funded as the owner." |
| Withdraw 1 NEAR from a 0.0483 vault | "The vault holds 0.0483 NEAR for this agent. Use Max to withdraw all of it." |

## Found and fixed after this run

- The wallet was not restored after a page reload. It is now reconnected from NEAR Connect's own saved choice, without opening the picker.
- The optional "Verify your NEAR account" banner stayed visible while a wallet was connected. It now hides.
- The 24-hour reset time used the browser's locale (`11/14/2026, 6:46 PM`). It is now unambiguous: `14 Nov 2026, 18:46 (13:16 UTC)`.
- After an owner transaction, the Check allowance and payment-check panels kept the old answer until clicked again. They now refresh on their own.
- The old example transactions are held by only one public archival operator, so a slow answer can turn a verdict into the safe `MANUAL_REVIEW_REQUIRED`. The examples now say so. (`archival-rpc.testnet.near.org` was checked: it is a DNS alias of FastNEAR, so adding it would count one operator twice.)
