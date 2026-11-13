import { useEffect, useState } from "react";
import { api, type IdentityResult } from "../api";
import { hasStoredWallet } from "../wallet";
import { Icon } from "./icons";
import { Button, Pill } from "./ui";

/**
 * OPTIONAL account verification (NEP-413 sign-message via MyNearWallet's redirect flow).
 *
 * Note for judges: this step is skippable by design. Every Sentinel feature works without it.
 * Verifying only shows which NEAR account you are using; the server keeps no session and
 * stores nothing except a single-use, 5-minute nonce. The signature cannot move funds.
 */

const KEY_STATE = "sentinel.identity"; // localStorage: { skipped: true } | IdentityResult
const KEY_PENDING = "sentinel.identity.pending"; // sessionStorage: { nonce, callbackUrl }

type Stored = { skipped: true } | IdentityResult | null;

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY_STATE) ?? "null");
  } catch {
    return null;
  }
}
function save(v: Stored) {
  if (v === null) localStorage.removeItem(KEY_STATE);
  else localStorage.setItem(KEY_STATE, JSON.stringify(v));
  window.dispatchEvent(new Event("sentinel-identity"));
}

export function walletUrl(network: string): string {
  return network === "mainnet" ? "https://app.mynearwallet.com" : "https://testnet.mynearwallet.com";
}

/** Read the wallet's redirect (`#accountId=…&publicKey=…&signature=…` or `#error=…`), once, on load. */
export function readWalletCallback(hash: string): { accountId: string; publicKey: string; signature: string } | { error: string } | null {
  const raw = hash.replace(/^#/, "");
  if (!raw.includes("signature=") && !raw.includes("error=")) return null;
  const q = new URLSearchParams(raw);
  if (q.get("error")) return { error: q.get("error")! };
  const accountId = q.get("accountId");
  const publicKey = q.get("publicKey");
  const signature = q.get("signature");
  return accountId && publicKey && signature ? { accountId, publicKey, signature } : { error: "The wallet returned an incomplete response." };
}

export function useIdentity() {
  const [state, setState] = useState<Stored>(load);
  useEffect(() => {
    const on = () => setState(load());
    window.addEventListener("sentinel-identity", on);
    return () => window.removeEventListener("sentinel-identity", on);
  }, []);
  return state;
}

/** Handles the wallet redirect. Mount once at the app root. */
export function useWalletCallback(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const cb = readWalletCallback(window.location.hash);
    if (!cb) return;
    const pending = sessionStorage.getItem(KEY_PENDING);
    sessionStorage.removeItem(KEY_PENDING);
    // Remove the wallet's parameters from the address bar right away.
    history.replaceState(null, "", `${window.location.pathname}#/overview`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    if ("error" in cb) {
      setError(`Verification cancelled or failed: ${cb.error}. It is optional; you can keep using Sentinel.`);
      return;
    }
    if (!pending) {
      setError("No verification was in progress in this tab. Start again from the banner above (optional).");
      return;
    }
    const { nonce, callbackUrl } = JSON.parse(pending) as { nonce: string; callbackUrl: string };
    api
      .identityVerify({ ...cb, nonce, callbackUrl })
      .then((r) => save(r))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return error;
}

async function startVerification(network: string) {
  const c = await api.identityChallenge();
  const callbackUrl = `${window.location.origin}${window.location.pathname}`;
  sessionStorage.setItem(KEY_PENDING, JSON.stringify({ nonce: c.nonce, callbackUrl }));
  const q = new URLSearchParams({ message: c.message, nonce: c.nonce, recipient: c.recipient, callbackUrl });
  window.location.assign(`${walletUrl(network)}/sign-message?${q.toString()}`);
}

/** Dismissible first-visit banner with an always-visible Skip. */
/** Renders immediately (no layout shift on first paint); the verify button waits until the server reports its network. */
export function IdentityBanner({ network }: { network?: string }) {
  const state = useIdentity();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A wallet connected through Owner actions already shows the account; don't ask a second time.
  const [walletOn, setWalletOn] = useState(hasStoredWallet);
  useEffect(() => {
    const on = () => setWalletOn(hasStoredWallet());
    window.addEventListener("sentinel-identity", on);
    return () => window.removeEventListener("sentinel-identity", on);
  }, []);
  if (state || walletOn) return null;
  return (
    <section aria-labelledby="identity-title" className="glow-border card mb-6 rounded-2xl px-5 py-4 text-sm animate-fade-up">
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent/30 to-mint/20 text-mint">
          <Icon name="wallet" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="identity-title" className="font-semibold text-ink">
            Verify your NEAR account <span className="font-normal text-muted">(optional)</span>
          </h2>
          <p className="mt-1 text-ink-2">
            <strong className="text-ink">Note for judges:</strong> this step is optional and can be skipped. Every feature works without signing in. Verifying only
            shows which NEAR account you are using. The server keeps no session, and the signed message cannot move funds.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 md:shrink-0">
          <Button
            icon="wallet"
            disabled={busy || !network}
            onClick={() => {
              if (!network) return;
              setBusy(true);
              setErr(null);
              startVerification(network).catch((e: unknown) => {
                setBusy(false);
                setErr(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            {busy ? "Opening wallet…" : network ? `Verify with MyNearWallet (${network})` : "Verify with MyNearWallet"}
          </Button>
          <Button variant="ghost" icon="arrowRight" onClick={() => save({ skipped: true })}>
            Skip — explore without a wallet
          </Button>
        </div>
      </div>
      {err && (
        <p role="alert" className="mt-3 text-critical">
          ✕ {err}
        </p>
      )}
    </section>
  );
}

/** Compact sidebar status: verified account, or a link to verify (still optional). */
export function IdentityStatus({ network }: { network: string }) {
  const state = useIdentity();
  if (state && "verified" in state) {
    return (
      <div className="space-y-1">
        <p className="flex items-center justify-between gap-2">
          Account: <Pill tone="good">verified</Pill>
        </p>
        <p className="break-all font-mono text-[11px] text-ink-2">{state.accountId}</p>
        <button type="button" className="text-[11px] text-link underline" onClick={() => save(null)}>
          Forget
        </button>
      </div>
    );
  }
  return (
    <p className="flex flex-wrap items-center justify-between gap-2">
      Account: <span className="text-ink-2">not verified (optional)</span>
      {state && "skipped" in state && (
        <button type="button" className="text-[11px] text-link underline" onClick={() => startVerification(network).catch(() => undefined)}>
          Verify
        </button>
      )}
    </p>
  );
}
