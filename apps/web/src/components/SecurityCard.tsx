import { Card, linkClass, Pill, type Tone } from "./ui";

const REPO = "https://github.com/kariosg/near-sentinel/blob/master";

/** Safety layers, from the agent's key down to independent proof. Order matters: each one limits the damage if the one above fails. */
const LAYERS: Array<[string, string]> = [
  ["Limited key", "The agent holds a function-call key that can only call the Vault's spend, never a full-access key. Check it with the Agent keys tool."],
  ["Vault limits on-chain", "Per-payment and 24-hour limits, a receiver allowlist and the balance are enforced by the contract, not by the AI's prompt, so a tricked agent cannot go past them."],
  ["Check before signing", "preflight_spend runs the Vault's own rules first, and check_receiver flags lookalike payees, address poisoning and missing accounts, so the agent stops early with a clear reason."],
  ["Pay once", "Each payment id can be paid only once (Guard and Vault), so a retry after a timeout can never pay twice."],
  ["Kill switch", "The owner can freeze the agent instantly and withdraw the balance at any time."],
  ["Independent proof", "Every answer is cross-checked on several RPC operators; if they disagree, Sentinel says so instead of guessing."],
];

type Cover = "yes" | "partial" | "no";
const coverTone: Record<Cover, Tone> = { yes: "good", partial: "warning", no: "neutral" };
const coverLabel: Record<Cover, string> = { yes: "Covered", partial: "Partly", no: "Not covered" };

/** OWASP Top 10 for Agentic Applications (2026): what Sentinel does for each risk, honestly. */
const OWASP: Array<[string, string, Cover, string]> = [
  ["ASI01", "Agent goal hijack", "yes", "Money rules live in the contract, not the prompt: a hijacked agent still meets the limits, the allowlist and the freeze; the receiver check flags the lookalike payee it was told to pay."],
  ["ASI02", "Tool misuse", "yes", "All 10 MCP tools are read-only (marked readOnlyHint). preflight_spend checks a payment before any signing tool is used."],
  ["ASI03", "Identity and privilege abuse", "yes", "Agent keys tool flags full-access keys; the Vault checks the direct caller (predecessor), not the signer; one allowance per owner + agent."],
  ["ASI04", "Agentic supply chain", "partial", "Pinned lockfile, pnpm audit, a secrets gate in tests and an open-source MCP server you can read. Third-party tools are your choice."],
  ["ASI05", "Unexpected code execution", "no", "Out of scope: Sentinel never runs code the agent writes."],
  ["ASI06", "Memory and context poisoning", "no", "Out of scope: Sentinel keeps no agent memory; every verdict is computed fresh from the chain."],
  ["ASI07", "Insecure inter-agent communication", "no", "Out of scope: Sentinel is not an agent-to-agent channel."],
  ["ASI08", "Cascading failures", "yes", "An RPC timeout is not treated as a failure: the verdict waits for proof, so one bad provider cannot trigger a double payment."],
  ["ASI09", "Human-agent trust exploitation", "yes", "Plain-language verdicts with per-provider evidence, and the safety check shows owners how risky their limits are."],
  ["ASI10", "Rogue agents", "yes", "Daily cap limits the loss, the freeze stops the agent at once, and the owner can withdraw everything."],
];

const STORES: Array<[string, string]> = [
  ["Provider health samples", "7 days"],
  ["Inspection reports (public chain data: hash, verdict)", "30 days"],
  ["Audit log of admin actions (IP stored only as a salted hash)", "30 days"],
  ["Private keys, seed phrases, wallet sessions", "Never: signing happens in your own wallet"],
  ["Cookies, analytics, trackers", "None"],
];

/** Security and privacy for AI agents: layers, the OWASP agentic mapping, and what the server stores. */
export function SecurityCard() {
  return (
    <Card title="Security & privacy for AI agents" icon="shieldCheck" subtitle="Give an agent money, not your keys — and keep its limits outside the AI">
      <div className="space-y-6 text-sm text-ink-2">
        <div>
          <p className="font-medium text-ink">Six safety layers</p>
          <ol className="mt-2 grid gap-2 md:grid-cols-2">
            {LAYERS.map(([t, d], i) => (
              <li key={t} className="rounded-xl border border-line bg-surface-2/40 px-3 py-2">
                <span className="font-medium text-ink">
                  {i + 1}. {t}
                </span>
                <span className="block text-xs">{d}</span>
              </li>
            ))}
          </ol>
        </div>

        <div>
          <p className="font-medium text-ink">
            Mapped to the{" "}
            <a className={linkClass} href="https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/" target="_blank" rel="noreferrer">
              OWASP Top 10 for Agentic Applications (2026)
            </a>
          </p>
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line" aria-label="OWASP agentic risks and what Sentinel does">
            {OWASP.map(([id, name, c, what]) => (
              <li key={id} className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[minmax(0,15rem)_auto_minmax(0,1fr)] sm:items-start sm:gap-3">
                <span className="text-ink">
                  <span className="font-mono text-muted">{id}</span> {name}
                </span>
                <span>
                  <Pill tone={coverTone[c]}>{coverLabel[c]}</Pill>
                </span>
                <span>{what}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="font-medium text-ink">What Sentinel stores</p>
          <dl className="mt-2 divide-y divide-line text-xs">
            {STORES.map(([what, how]) => (
              <div key={what} className="grid gap-0.5 py-1.5 sm:grid-cols-[1fr_auto] sm:gap-4">
                <dt>{what}</dt>
                <dd className="font-medium text-ink sm:text-right">{how}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted">
            Anything an agent writes on-chain (amounts, receivers, payment ids) is public forever: use a hashed payment id (privateIntentId in the SDK), never an email or order
            number. Self-host the Docker image for full control.{" "}
            <a className={linkClass} href={`${REPO}/docs/PRIVACY.md`} target="_blank" rel="noreferrer">
              Privacy
            </a>{" "}
            ·{" "}
            <a className={linkClass} href={`${REPO}/SECURITY.md`} target="_blank" rel="noreferrer">
              Security
            </a>
          </p>
        </div>
      </div>
    </Card>
  );
}
