/**
 * Real testnet demo data for judges and testers: every hash below is a real transaction, every account a real testnet
 * account. Nothing is mocked. Verdicts were checked against the live API on 2026-11-12.
 */
import type { IconName } from "./components/icons";

export const explorerTx = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string) => `https://testnet.nearblocks.io/address/${id}`;

export interface DemoTx {
  key: string;
  label: string;
  /** Visible "what you'll see" line. */
  expect: string;
  /** One plain-language sentence: what happened in this transaction. */
  story: string;
  icon: IconName;
  hash: string;
  sender: string;
  group: "real-money" | "edge-case";
}

export const DEMO_TXS: DemoTx[] = [
  {
    key: "guarded",
    label: "Guarded agent paid once",
    expect: "DO_NOT_RETRY: it landed, so paying again would double-pay",
    story: "Real money: the reply timed out, the agent asked Sentinel, got DO_NOT_RETRY and paid only once.",
    icon: "check",
    hash: "C59gttNUHCaVTHVi2GKCw6zu5C7QcmwPbUuw9NeaXnzS",
    sender: "karios.testnet",
    group: "real-money",
  },
  {
    key: "naive1",
    label: "Naive agent, payment 1",
    expect: "DO_NOT_RETRY: this one landed…",
    story: "Real money: the naive agent's first payment landed, but its reply timed out, so the agent thought it failed.",
    icon: "x",
    hash: "185YtdJZxUCMAaqjRtmSj4MTx51mdiMpjhAPmZ3rZaH",
    sender: "karios.testnet",
    group: "real-money",
  },
  {
    key: "naive2",
    label: "Naive agent, payment 2",
    expect: "DO_NOT_RETRY: …and so did this duplicate",
    story: "Real money: the naive agent signed a new payment without checking, so the receiver was paid twice.",
    icon: "x",
    hash: "6h2hMxjpjdYwDF6zXJ5gTwD5MY47UT7thdRaxZM2Pc6h",
    sender: "karios.testnet",
    group: "real-money",
  },
  {
    key: "nonce",
    label: "Nonce proof",
    expect: "DO_NOT_RETRY on this tx; it used the nonce of an unsent payment",
    story: "This transaction used the same nonce as an earlier signed-but-unsent payment, so Sentinel proved that payment can never land (SAFE_TO_RETRY).",
    icon: "lock",
    hash: "6jM2toRMAb9KDNTSNHrCVSGEY5ttJenXnAiirBPE7wnj",
    sender: "karios.testnet",
    group: "real-money",
  },
  {
    key: "success",
    label: "Succeeded",
    expect: "DO_NOT_RETRY",
    story: "A normal successful contract call.",
    icon: "check",
    hash: "9WeBPyuE9vC6CSTUF2iSujGq7Use1B4SrSfcPZNkRsc8",
    sender: "atlas.loca-swarm-mvwu8dfo.testnet",
    group: "edge-case",
  },
  {
    key: "receipts",
    label: "Multi-receipt success",
    expect: "DO_NOT_RETRY, with 2 receipts in the graph",
    story: "One transaction that ran as two receipts; both succeeded.",
    icon: "check",
    hash: "49KZfj1YECgEdJQZT6DC4wkWd5m4GsjVSh8kGKdbj3e7",
    sender: "ai-13.near-post.testnet",
    group: "edge-case",
  },
  {
    key: "panic",
    label: "Contract panic",
    expect: "an explained failure (it asks for review until 2 operators confirm it)",
    story: "The contract panicked; Sentinel explains why.",
    icon: "x",
    hash: "8mSLr4P4p576mKVyLwMEKMmaqGLmW7NwLqDd28s5zeiK",
    sender: "predit-fc-operator.testnet",
    group: "edge-case",
  },
  {
    key: "partial",
    label: "Partially completed",
    expect: "MANUAL_REVIEW_REQUIRED",
    story: "The top-level call said success, but a downstream call (ft_burn) failed. Top-level status hides this.",
    icon: "hand",
    hash: "EtpgCjJPA1WN9MxG17C88GtEU5kf6mx77YxhrWdjMuBd",
    sender: "amstr-admin-zxlhcx.testnet",
    group: "edge-case",
  },
];

/** The real testnet accounts used by the demos. */
export const DEMO_ACCOUNTS: Array<{ id: string; role: string }> = [
  { id: "karios.testnet", role: "Payer and Vault owner: the account whose agent sends payments" },
  { id: "kariosr.testnet", role: "Receiver in the real-money demo, and the agent of the live Vault allowance (which may pay only karios.testnet)" },
  { id: "guard.karios.testnet", role: "Sentinel Guard contract: pays at most once per intent" },
  { id: "vault.karios.testnet", role: "Sentinel Vault contract: an allowance the agent spends with limits" },
];
