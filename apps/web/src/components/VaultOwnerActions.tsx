import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { friendlyVaultError, nearExact, nearOf, RECORD_FEE_NEAR } from "../vaultInfo";
import { accountBalance, connectWallet, disconnectWallet, nearToYocto, signAndSendFunctionCall, type Connected } from "../wallet";
import { Icon } from "./icons";
import { Help } from "./Term";
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

const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** NEAR keeps a little in the wallet for gas; warn before a deposit would leave less than this. */
const GAS_MARGIN_YOCTO = 10n ** 22n; // 0.01 NEAR

/**
 * Owner actions on a Sentinel Vault, signed by the owner's own wallet through NEAR Connect.
 * Every action is checked against the live state, previewed exactly as it will be signed, and needs a second, explicit click.
 */
export function VaultOwnerActions({ contract }: { contract: string }) {
  const vault = contract.trim() || "vault.karios.testnet";
  const [conn, setConn] = useState<Connected>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; raw?: string; hash?: string }>();
  const [action, setAction] = useState<Action>("fund");
  const [agent, setAgent] = useState("");
  const [perPayment, setPerPayment] = useState("0.05");
  const [perDay, setPerDay] = useState("0.1");
  const [receivers, setReceivers] = useState("");
  const [deposit, setDeposit] = useState("0.2");
  const [frozen, setFrozen] = useState(true);
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState<Pending>();

  // Look up the current allowance for (connected owner, agent) once typing pauses.
  const [agentQ, setAgentQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAgentQ(agent.trim()), 500);
    return () => clearTimeout(t);
  }, [agent]);
  const owner = conn?.accountId;
  const current = useQuery({
    queryKey: ["ownerAllowance", vault, owner, agentQ],
    queryFn: () => api.allowance({ contract: vault, owner: owner!, agent: agentQ }),
    enabled: !!owner && ACCOUNT_RE.test(agentQ),
    staleTime: 5_000,
  });
  const wallet = useQuery({ queryKey: ["walletBalance", owner], queryFn: () => accountBalance(owner!), enabled: !!owner, staleTime: 5_000 });
  const policy = current.data?.policy;
  const status = current.data?.status;
  const prefilled = useRef("");
  useEffect(() => {
    const key = `${owner}|${agentQ}`;
    if (!policy || prefilled.current === key) return;
    prefilled.current = key;
    setPerPayment(nearExact(policy.per_payment_max));
    setPerDay(nearExact(policy.daily_max));
    setReceivers(policy.allowed_receivers.join(", "));
  }, [policy, owner, agentQ]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const connect = async () => {
    setMsg(undefined);
    setBusy(true);
    try {
      setConn(await connectWallet());
    } catch (e) {
      const raw = (e as Error).message || "cancelled";
      setMsg({ kind: "err", text: `Wallet not connected: ${friendlyVaultError(raw)}`, raw });
    } finally {
      setBusy(false);
    }
  };

  const preview = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(undefined);
    try {
      const agent_id = agent.trim();
      if (!agent_id) throw new Error("Enter the agent account.");
      if (!ACCOUNT_RE.test(agent_id)) throw new Error(`"${agent_id}" is not a valid NEAR account id.`);
      // Validate against fresh on-chain state, never a stale cache. If it can't be read, the contract still decides.
      const fresh = owner && agentQ === agent_id ? (await current.refetch()).data : undefined;
      const loadedFor = fresh && fresh.status !== "UNKNOWN" ? fresh : undefined;
      if (action === "fund") {
        const allowed_receivers = receivers.split(",").map((s) => s.trim()).filter(Boolean);
        if (loadedFor?.policy?.allowed_receivers.length && allowed_receivers.length === 0)
          throw new Error(`This would remove the receiver allowlist (${loadedFor.policy.allowed_receivers.join(", ")}) and let the agent pay anyone. Re-enter the receivers, or type "any" to allow every receiver.`);
        const per = nearToYocto(perPayment);
        const day = nearToYocto(perDay);
        const dep = nearToYocto(deposit);
        if (BigInt(per) === 0n) throw new Error("The per-payment limit must be more than 0.");
        if (BigInt(per) > BigInt(day)) throw new Error("The per-payment limit must not be higher than the 24-hour limit.");
        if (allowed_receivers.length > 20) throw new Error("Use at most 20 allowed receivers.");
        if (allowed_receivers.length === 1 && allowed_receivers[0]!.toLowerCase() === "any") allowed_receivers.length = 0;
        const bad = allowed_receivers.find((r) => !ACCOUNT_RE.test(r));
        if (bad) throw new Error(`"${bad}" is not a valid NEAR account id.`);
        if (allowed_receivers.includes(vault)) throw new Error("The vault contract itself cannot be a receiver.");
        if (wallet.data && BigInt(dep) + GAS_MARGIN_YOCTO > BigInt(wallet.data.available))
          throw new Error(`Your wallet has ${nearOf(wallet.data.available)} NEAR available. Keep about 0.01 NEAR for gas, so deposit less.`);
        setPending({ method: "set_policy", args: { agent_id, per_payment_max: per, daily_max: day, allowed_receivers }, depositYocto: dep, depositNear: deposit.trim() });
      } else if (action === "freeze") {
        if (loadedFor?.status === "NO_POLICY") throw new Error(`${owner} has no allowance for ${agent_id}. You can only freeze allowances you funded as the owner.`);
        setPending({ method: "set_frozen", args: { agent_id, frozen }, depositYocto: "0", depositNear: "0" });
      } else {
        const y = nearToYocto(amount);
        if (BigInt(y) === 0n) throw new Error("The amount must be more than 0.");
        if (loadedFor?.status === "NO_POLICY") throw new Error(`${owner} has no allowance for ${agent_id}. You can only withdraw from allowances you funded as the owner.`);
        if (loadedFor?.policy && BigInt(y) > BigInt(loadedFor.policy.balance))
          throw new Error(`The vault holds ${nearOf(loadedFor.policy.balance)} NEAR for this agent. Use Max to withdraw all of it.`);
        setPending({ method: "withdraw", args: { agent_id, amount: y }, depositYocto: "0", depositNear: "0" });
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
      setMsg({ kind: "ok", text: `${pending.method} sent. The figures below refresh in a few seconds.`, hash });
      setPending(undefined);
      // Final state needs a couple of blocks; refresh then.
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void current.refetch();
        void wallet.refetch();
      }, 3_000);
    } catch (e) {
      const raw = (e as Error).message || "cancelled in the wallet";
      const onChain = /\(tx [1-9A-HJ-NP-Za-km-z]{43,44}\)$/.exec(raw);
      const hash = onChain ? raw.slice(onChain.index + 4, -1) : undefined;
      setMsg({ kind: "err", text: `${hash ? "Failed on-chain (the transaction was sent; only gas was used)" : "Not sent"}: ${friendlyVaultError(raw)}`, raw, hash });
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
                clearTimeout(refreshTimer.current);
                setConn(undefined);
                setPending(undefined);
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

      {conn ? (
        <div className="mt-3 space-y-1.5 rounded-lg border border-line bg-surface/60 px-3 py-2 text-xs text-ink-2">
          <p>
            <span className="text-muted">Your wallet:</span>{" "}
            {wallet.data ? (
              <>
                <strong className="text-ink">{nearOf(wallet.data.available)} NEAR available</strong>
                <Help label="available">What your wallet can spend now: total minus the part NEAR reserves for your account&apos;s storage. Keep about 0.01 NEAR for gas.</Help>
                <span className="text-muted"> · </span>
                {nearOf(wallet.data.storageReserved)} reserved for storage
                <Help label="reserved for storage">NEAR keeps this much in every account to pay for the data the account stores. It can&apos;t be spent.</Help>
                {BigInt(wallet.data.locked) > 0n && (
                  <>
                    <span className="text-muted"> · </span>
                    {nearOf(wallet.data.locked)} staked
                    <Help label="staked">NEAR locked in staking. It can&apos;t be used here until it is unstaked.</Help>
                  </>
                )}
                <span className="text-muted"> · balance {nearOf(wallet.data.total)} (not counting staked)</span>
              </>
            ) : wallet.isError ? (
              <span>balance unavailable right now (your wallet app shows it too)</span>
            ) : (
              <span>loading…</span>
            )}
          </p>
          <p>
            <span className="text-muted">Allowance {owner} → {agentQ || "agent"}:</span>{" "}
            {!ACCOUNT_RE.test(agentQ) ? (
              <span>type the agent account below to see it.</span>
            ) : current.isFetching && !current.data ? (
              <span>loading…</span>
            ) : status === "NO_POLICY" ? (
              <span>
                <strong className="text-ink">none yet</strong>. You are not the owner of an allowance for this agent; create one with Fund.
              </span>
            ) : policy ? (
              <span>
                <strong className={policy.frozen ? "text-critical" : "text-ink"}>{status}</strong> · vault balance {nearOf(policy.balance)} NEAR · per payment{" "}
                {nearOf(policy.per_payment_max)} / per 24 h {nearOf(policy.daily_max)} NEAR · {policy.frozen ? "frozen" : "not frozen"}
              </span>
            ) : current.isError ? (
              <span>could not be read right now; the contract still checks everything when you sign.</span>
            ) : (
              <span>{status ?? "…"}</span>
            )}
          </p>
          <p className="text-muted">
            You can only manage allowances that <span className="font-mono">{conn.accountId}</span> funded as the owner. An agent can never freeze or withdraw its
            owner&apos;s money.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-muted">Connect the owner&apos;s wallet to see its balance and the current allowance before you sign anything.</p>
      )}

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
              setMsg(undefined);
            }}
            className={`rounded-md px-3 py-1.5 font-medium transition ${action === a.id ? "bg-surface-3 text-ink" : "text-muted hover:text-ink"}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <p className="mt-2 text-[11px] text-ink-2">
        {action === "fund" && (
          <>
            Creates the allowance, or replaces its limits <strong className="text-ink">and receiver list</strong> and adds the deposit to the vault balance. Each agent payment also takes a {RECORD_FEE_NEAR} NEAR fee.
            <Help label="first deposit">Part of the deposit pays NEAR storage for the allowance (more for a new allowance or a longer receiver list, usually around 0.002 to 0.02 NEAR), so the vault balance grows a little less than you deposit. An update that adds receivers needs a deposit too.</Help>
          </>
        )}
        {action === "freeze" && (
          <>
            Freezing stops the agent from paying at once; unfreezing lets it pay again. Money stays in the vault.
            {policy && <strong className="ml-1 text-ink">Currently: {policy.frozen ? "FROZEN" : "not frozen"}.</strong>}
          </>
        )}
        {action === "withdraw" && (
          <>
            Sends NEAR from the vault back to your wallet, up to the whole vault balance.
            <Help label="how much can I withdraw">At most the vault balance shown above. Part of each deposit paid for NEAR storage, so the balance is a little below what you deposited. Use Max for the exact amount.</Help>
          </>
        )}
      </p>

      <form onSubmit={preview} className="mt-3 grid gap-3 md:grid-cols-3 md:items-end">
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
        {action === "withdraw" && (
          <div className="flex items-end gap-2">
            <Field label="Amount to withdraw (NEAR)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required className="flex-1" />
            {policy && agentQ === agent.trim() && (
              <Button size="sm" variant="ghost" onClick={() => setAmount(nearExact(policy.balance))} className="mb-[3px]">
                Max
              </Button>
            )}
          </div>
        )}
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
        <div className={`mt-3 text-sm ${msg.kind === "ok" ? "text-good" : "text-serious"}`} aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <Icon name={msg.kind === "ok" ? "check" : "info"} size={14} />
            {msg.text}
            {msg.hash && (
              <a className="text-link underline" href={`https://testnet.nearblocks.io/txns/${msg.hash}`} target="_blank" rel="noreferrer">
                {msg.hash.slice(0, 10)}… on NearBlocks
              </a>
            )}
          </p>
          {msg.raw && friendlyVaultError(msg.raw) !== msg.raw && (
            <details className="mt-1 text-xs text-muted">
              <summary className="cursor-pointer">Technical details</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono">{msg.raw}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
