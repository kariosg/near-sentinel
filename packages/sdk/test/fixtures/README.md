# Fixtures

Real `EXPERIMENTAL_tx_status` results captured from NEAR **testnet** on 2026-11-09 via
`https://test.rpc.fastnear.com` with `wait_until: "NONE"`. They are unmodified `result` objects.

| File | Tx hash | What it shows |
|---|---|---|
| `tx-success.json` | `9WeBPyuE9vC6CSTUF2iSujGq7Use1B4SrSfcPZNkRsc8` | Function call that succeeded |
| `tx-success-2receipts.json` | `49KZfj1YECgEdJQZT6DC4wkWd5m4GsjVSh8kGKdbj3e7` | Success plus a refund receipt |
| `tx-failure-panic.json` | `8mSLr4P4p576mKVyLwMEKMmaqGLmW7NwLqDd28s5zeiK` | Contract panicked: "Market has not expired" |
| `tx-partial.json` | `EtpgCjJPA1WN9MxG17C88GtEU5kf6mx77YxhrWdjMuBd` | `run_buyback` root succeeded, but downstream `ft_burn` and `ft_transfer_call` panicked |

Tests also derive **synthetic** variants (pending receipts, conflicting outcomes) from these files. Every
synthetic object is built in the test file itself and labelled `synthetic`.
