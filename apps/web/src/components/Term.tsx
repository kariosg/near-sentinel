import type { ReactNode } from "react";
import { Icon } from "./icons";
import { Tooltip } from "./ui";

/** Plain-language definitions of the NEAR terms the dashboard uses. Shown in tooltips and in the Start page glossary. */
export const GLOSSARY = {
  nonce: {
    term: "Nonce",
    text: "A counter on each NEAR access key. Every transaction uses the next number, and each number can be used once. If a later transaction used a nonce, an older unsent one with that nonce can never land.",
  },
  validity: {
    term: "Validity window",
    text: "A signed NEAR transaction names a recent block. About a day of blocks later it expires and the network will refuse it forever.",
  },
  operators: {
    term: "Independent operators",
    text: "Different companies running RPC nodes (here FastNEAR, dRPC and Intear). Sentinel only says 'safe' when at least two of them agree, so one bad node can't fool it.",
  },
  receipts: {
    term: "Receipts",
    text: "On NEAR a transaction runs as a chain of receipts, often across several contracts. The top-level status can say success while a later receipt failed; Sentinel checks all of them.",
  },
  fckey: {
    term: "Function-call key",
    text: "A limited NEAR access key that can only call named methods of one contract and cannot transfer NEAR directly. The Vault gives the agent one that can only call spend().",
  },
  intent: {
    term: "Intent",
    text: "Your own ID for 'this one payment' (for example an invoice number). The Guard contract pays each intent at most once, so a retry with the same intent is refused and refunded.",
  },
  allowance: {
    term: "Allowance",
    text: "Money the owner puts in the Vault for an agent, with a per-payment limit, a 24-hour limit and an optional list of allowed receivers.",
  },
} as const;

export type TermKey = keyof typeof GLOSSARY;

/** A small ⓘ help button; tap, hover or keyboard focus shows the text. `label` names it for screen readers. */
export function Help({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip tip={children} align="start">
      <button
        type="button"
        aria-label={`Help: ${label}`}
        className="ml-1 inline-grid h-4 w-4 cursor-help place-items-center rounded-full align-middle text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-link/40"
      >
        <Icon name="info" size={13} />
      </button>
    </Tooltip>
  );
}

/** A term with a dotted underline; tap, hover or focus shows its plain-language meaning. */
export function Term({ k, children }: { k: TermKey; children?: ReactNode }) {
  const g = GLOSSARY[k];
  return (
    <Tooltip tip={<><strong className="text-ink">{g.term}:</strong> {g.text}</>}>
      <button type="button" className="cursor-help underline decoration-dotted decoration-muted underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-link/40 rounded-sm">
        {children ?? g.term}
      </button>
    </Tooltip>
  );
}
