import { Icon } from "./icons";
import { toneText, verdictTone } from "./ui";

/**
 * Static decision tree: how Sentinel picks a verdict (mirrors packages/sdk/src/retry.ts).
 * Plain HTML, so it reflows on phones and screen readers read it as a list.
 */
const BRANCHES: Array<{ q: string; a: string; verdict: string; why: string }> = [
  { q: "Found, but providers report different outcomes?", a: "yes", verdict: "MANUAL_REVIEW_REQUIRED", why: "Sentinel never guesses between conflicting answers." },
  { q: "Found and succeeded, or still executing?", a: "yes", verdict: "DO_NOT_RETRY", why: "It landed or is landing. Paying again would pay twice." },
  { q: "Found, but a downstream receipt failed?", a: "yes", verdict: "MANUAL_REVIEW_REQUIRED", why: "Part of it ran. A human or the agent's own logic must decide." },
  { q: "Found and failed with no side effects, final on ≥ 2 independent operators?", a: "yes", verdict: "SAFE_TO_RETRY", why: "Nothing moved, so a new transaction is safe. Fewer operators: WAIT_AND_RECHECK." },
  { q: "Not found, signed bytes given, and on ≥ 2 operators that hold the history: nonce used or validity window expired?", a: "yes", verdict: "SAFE_TO_RETRY", why: "Proven: it can never land." },
  { q: "Not found, some sign it can't land, but not proven on enough operators?", a: "yes", verdict: "MANUAL_REVIEW_REQUIRED", why: "Likely dead, but not proven. Don't sign anything new yet." },
  { q: "Otherwise (not found, not proven, or no signed bytes)", a: "otherwise", verdict: "WAIT_AND_RECHECK", why: "It may still land. Re-send the same signed bytes only, then check again." },
];

const SHORT: Record<string, string> = {
  DO_NOT_RETRY: "Do not retry",
  MANUAL_REVIEW_REQUIRED: "Manual review",
  SAFE_TO_RETRY: "Safe to retry",
  WAIT_AND_RECHECK: "Wait and re-check",
};

export function VerdictTree() {
  return (
    <figure className="card mt-5 rounded-2xl border border-line p-5" aria-labelledby="verdict-tree-title">
      <figcaption id="verdict-tree-title" className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="layers" size={17} className="text-link" />
        How Sentinel decides, checked in this order
      </figcaption>
      <ol className="mt-4 space-y-2.5">
        {BRANCHES.map((b, i) => {
          const tone = verdictTone(b.verdict);
          return (
            <li key={b.q} className="grid gap-2 rounded-xl border border-line bg-surface-2/40 p-3 text-sm sm:grid-cols-[1.4fr_auto_1fr] sm:items-center">
              <span className="text-ink-2">
                <span className="mr-2 font-mono text-xs text-muted">{i + 1}.</span>
                {b.q}
              </span>
              <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex" aria-hidden>
                {b.a} <Icon name="arrowRight" size={14} />
              </span>
              <span>
                <span className={`font-mono text-xs font-semibold ${toneText[tone]}`}>
                  <span className="sr-only">{b.a === "yes" ? "If yes: " : "Otherwise: "}</span>
                  {b.verdict}
                </span>
                <span className="ml-1.5 text-xs text-muted">({SHORT[b.verdict]})</span>
                <span className="block text-xs text-ink-2">{b.why}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-muted">Unknown is never reported as safe. Full rules: packages/sdk/src/retry.ts.</p>
    </figure>
  );
}
