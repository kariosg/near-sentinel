import { useState, type FormEvent } from "react";
import { connectWallet, disconnectWallet, nearToYocto, signAndSendFunctionCall, type Connected } from "../wallet";
import { Icon } from "./icons";
import { Button, Field } from "./ui";

type Action = "fund" | "freeze" | "withdraw";
interface Pending {
  method: string;
  args: Record<string, unknown>;
  depositYocto: string;
  depositNear: string;
}

const ACTIONS: Array<{ id: Action; label: string }> = [
  { id: "fund", label: "Fund / update policy" },
  { id: "freeze", label: "Freeze / unfreeze" },
  { id: "withdraw", label: "Withdraw" },
];

/**
 * Owner actions on a Sentinel Vault, signed by the owner's own wallet through NEAR Connect.
 * Every action is previewed exactly as it will be signed and needs a second, explicit click.
 */
export function VaultOwnerActions({ contract }: { contract: string }) {
  const vault = contract.trim() || "vault.karios.testnet";
  const [conn, setConn] = useState<Connected>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; hash?: string }>();
  const [action, setAction] = useState<Action>("fund");
  const [agent, setAgent] = useState("");
  const [perPayment, setPerPayment] = useState("0.05");
  const [perDay, setPerDay] = useState("0.1");
  const [receivers, setReceivers] = useState("");
  const [deposit, setDeposit] = useState("0.2");
  const [frozen, setFrozen] = useState(true);
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState<Pending>();

  const connect = async () => {
    setMsg(undefined);
    setBusy(true);
    try {
      setConn(await connectWallet());
    } catch (e) {
      setMsg({ kind: "err", text: `Wallet not connected: ${(e as Error).message || "cancelled"}` });
    } finally {
      setBusy(false);
    }
  };

  const preview = (e: FormEvent) => {
    e.preventDefault();
    setMsg(undefined);
    try {
      const agent_id = agent.trim();
      if (!agent_id) throw new Error("Enter the agent account.");
      if (action === "fund") {
        const allowed_receivers = receivers.split(",").map((s) => s.trim()).filter(Boolean);
        setPending({
          method: "set_policy",
          args: { agent_id, per_payment_max: nearToYocto(perPayment), daily_max: nearToYocto(perDay), allowed_receivers },
          depositYocto: nearToYocto(deposit),
          depositNear: deposit.trim(),
        });
      } else if (action === "freeze") {
        setPending({ method: "set_frozen", args: { agent_id, frozen }, depositYocto: "0", depositNear: "0" });
      } else {
        setPending({ method: "withdraw", args: { agent_id, amount: nearToYocto(amount) }, depositYocto: "0", depositNear: "0" });
      }
    } catch (err) {
      setPending(undefined);
      setMsg({ kind: "err", text: (err as Error).message });
    }
  };

  const sign = async () => {
    if (!pending || !conn) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const hash = await signAndSendFunctionCall(conn.wallet, conn.accountId, vault, pending.method, pending.args, pending.depositYocto);
      setMsg({ kind: "ok", text: `${pending.method} sent.`, hash });
      setPending(undefined);
    } catch (e) {
      setMsg({ kind: "err", text: `Not sent: ${(e as Error).message || "cancelled in the wallet"}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="owner-actions-title" className="mt-6 rounded-xl border border-line bg-surface-2/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="owner-actions-title" className="text-sm font-semibold text-ink">
            Owner actions (your wallet signs)
          </h3>
          <p className="text-xs text-muted">Via NEAR Connect on testnet. Sentinel never sees or holds a key; you approve every transaction in your wallet.</p>
        </div>
        {conn ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-good/15 px-2.5 py-1 font-mono text-good">{conn.accountId}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void disconnectWallet(conn.wallet);
                setConn(undefined);
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <Button size="sm" icon="wallet" onClick={connect} disabled={busy}>
            Connect wallet
          </Button>
        )}
      </div>

      <div role="tablist" aria-label="Owner action" className="mt-4 inline-flex rounded-lg border border-line bg-surface p-1 text-xs">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={action === a.id}
            onClick={() => {
              setAction(a.id);
              setPending(undefined);
            }}
            className={`rounded-md px-3 py-1.5 font-medium transition ${action === a.id ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <form onSubmit={preview} className="mt-4 grid gap-3 md:grid-cols-3 md:items-end">
        <Field label="Agent to manage" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="e.g. agent.alice.testnet" required />
        {action === "fund" && (
          <>
            <Field label="Per payment (NEAR)" value={perPayment} onChange={(e) => setPerPayment(e.target.value)} inputMode="decimal" required />
            <Field label="Per 24 h (NEAR)" value={perDay} onChange={(e) => setPerDay(e.target.value)} inputMode="decimal" required />
            <Field label="Allowed receivers (comma-separated, empty = any)" value={receivers} onChange={(e) => setReceivers(e.target.value)} placeholder="e.g. shop.testnet" className="md:col-span-2" />
            <Field label="Deposit to add (NEAR)" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" required />
          </>
        )}
        {action === "freeze" && (
          <label className="flex items-center gap-2 text-xs font-medium text-ink-2">
            <input type="checkbox" checked={frozen} onChange={(e) => setFrozen(e.target.checked)} /> Frozen (uncheck to unfreeze)
          </label>
        )}
        {action === "withdraw" && <Field label="Amount to withdraw (NEAR)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />}
        <Button type="submit" variant="subtle" icon="search">
          Preview transaction
        </Button>
      </form>

      {pending && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" aria-live="polite">
          <p className="font-medium text-ink">Your wallet will sign:</p>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-ink-2">
            {`${vault}.${pending.method}(${JSON.stringify(pending.args)}) with deposit ${pending.depositNear} NEAR (${pending.depositYocto} yoctoNEAR)`}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" icon="lock" onClick={sign} disabled={!conn || busy}>
              {busy ? "Waiting for wallet…" : "Sign in wallet"}
            </Button>
            {!conn && <span className="text-xs text-muted">Connect your wallet first.</span>}
            <Button size="sm" variant="ghost" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {msg && (
        <p className={`mt-3 flex items-center gap-2 text-sm ${msg.kind === "ok" ? "text-good" : "text-serious"}`} aria-live="polite">
          <Icon name={msg.kind === "ok" ? "check" : "info"} size={14} />
          {msg.text}
          {msg.hash && (
            <a className="text-link underline" href={`https://testnet.nearblocks.io/txns/${msg.hash}`} target="_blank" rel="noreferrer">
              {msg.hash.slice(0, 10)}… on NearBlocks
            </a>
          )}
        </p>
      )}
    </section>
  );
}
