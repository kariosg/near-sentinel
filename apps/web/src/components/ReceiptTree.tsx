import { useState } from "react";
import type { ReceiptNode } from "../api";
import { Button, download, Mono, Pill } from "./ui";

const statusTone = (s: ReceiptNode["status"]) => (s === "SUCCESS" ? "good" : s === "FAILURE" ? "critical" : "warning");
const statusLabel = (s: ReceiptNode["status"]) => (s === "SUCCESS" ? "Success" : s === "FAILURE" ? "Failed" : "Pending");

function countNodes(n: ReceiptNode): number {
  return 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
}
function collectIds(n: ReceiptNode, out: string[] = []): string[] {
  out.push(n.receiptId);
  n.children.forEach((c) => collectIds(c, out));
  return out;
}

function Node({ node, open, toggle, network }: { node: ReceiptNode; open: Set<string>; toggle: (id: string) => void; network: string }) {
  const isOpen = open.has(node.receiptId);
  const hasDetails = node.actions.length > 0 || node.logs.length > 0 || node.failure || node.children.length > 0;
  const tone = statusTone(node.status);
  return (
    <li className="relative">
      <div
        className={`group rounded-lg border px-3 py-2 ${node.status === "FAILURE" ? "border-critical/50 bg-critical/5" : node.isRefund ? "border-line/60 bg-transparent" : "border-line bg-surface-2"}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => toggle(node.receiptId)}
            aria-expanded={isOpen}
            disabled={!hasDetails}
            className="w-5 text-left text-muted disabled:opacity-30"
            title={isOpen ? "Collapse" : "Expand"}
          >
            {hasDetails ? (isOpen ? "▾" : "▸") : "·"}
          </button>
          <Pill tone={tone}>{statusLabel(node.status)}</Pill>
          <span className={`text-sm font-medium ${node.isRefund ? "text-muted" : "text-ink"}`}>{node.executorId}</span>
          {node.actions.map((a, i) => (
            <span key={i} className="rounded bg-page px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
              {a.methodName ? `${a.methodName}()` : a.type}
            </span>
          ))}
          {node.isRefund && <span className="text-xs text-muted">refund</span>}
          <span className="ml-auto text-xs text-muted tabular">
            {(node.gasBurnt / 1e12).toFixed(3)} Tgas
          </span>
        </div>
        {node.failure && <p className="mt-1.5 pl-7 text-sm text-critical">✕ {node.failure.message}</p>}
        {isOpen && (
          <div className="mt-2 space-y-1.5 pl-7 text-xs text-ink-2">
            <p>
              receipt <Mono>{node.receiptId}</Mono>
              {node.predecessorId && (
                <>
                  {" "}
                  · from <Mono>{node.predecessorId}</Mono>
                </>
              )}
            </p>
            <p>
              tokens burnt <Mono>{node.tokensBurnt}</Mono> yoctoNEAR · block <Mono>{node.blockHash || "—"}</Mono>
            </p>
            {node.actions.map((a, i) => (
              <p key={i}>
                action {i + 1}: <Mono>{a.summary ?? a.type}</Mono>
                {a.deposit && a.deposit !== "0" ? <> · deposit <Mono>{a.deposit}</Mono></> : null}
              </p>
            ))}
            {node.failure && (
              <p>
                error path <Mono>{node.failure.path.join(" › ")}</Mono>
              </p>
            )}
            {node.logs.length > 0 && (
              <div>
                <p>logs:</p>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-page p-2 font-mono text-[11px] text-ink-2">{node.logs.join("\n")}</pre>
              </div>
            )}
            <a className="text-link underline underline-offset-2 hover:no-underline" href={`https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/receipts/${node.receiptId}`} target="_blank" rel="noreferrer">
              View on NearBlocks ↗
            </a>
          </div>
        )}
      </div>
      {isOpen && node.children.length > 0 && (
        <ul className="ml-5 mt-2 space-y-2 border-l border-axis pl-4">
          {node.children.map((c) => (
            <Node key={c.receiptId} node={c} open={open} toggle={toggle} network={network} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ReceiptTree({ root, txHash, network }: { root: ReceiptNode; txHash: string; network: string }) {
  // Default: expand the path to every failure, so problems are visible immediately.
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const walk = (n: ReceiptNode): boolean => {
      const childFail = n.children.map(walk).some(Boolean);
      const here = n.status === "FAILURE" || childFail;
      if (childFail || n.depth === 0) s.add(n.receiptId);
      return here;
    };
    walk(root);
    return s;
  });
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const total = countNodes(root);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{total} {total === 1 ? "receipt" : "receipts"} (refunds included) · failures are auto-expanded</span>
        <span className="ml-auto" />
        <Button variant="ghost" onClick={() => setOpen(new Set(collectIds(root)))}>
          Expand all
        </Button>
        <Button variant="ghost" onClick={() => setOpen(new Set())}>
          Collapse all
        </Button>
        <Button variant="ghost" onClick={() => download(`receipt-graph-${txHash}.json`, root)}>
          Export graph (JSON)
        </Button>
      </div>
      <ul className="space-y-2">
        <Node node={root} open={open} toggle={toggle} network={network} />
      </ul>
    </div>
  );
}
