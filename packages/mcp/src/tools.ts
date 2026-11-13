/**
 * NEAR Sentinel MCP tools. Every tool is READ-ONLY: nothing is signed or submitted.
 * Tools return a short human/LLM-readable verdict in `content` and the full machine-readable
 * result in `structuredContent`.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { diagnoseSubmissionError, type InspectionResult, type NearSentinel } from "@near-sentinel/sdk";
import * as z from "zod/v4";

export const SERVER_NAME = "near-sentinel";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const txRef = z.object({
  signedTransactionBase64: z
    .string()
    .optional()
    .describe(
      "Base64 borsh SignedTransaction you submitted (contains NO private key). Strongly preferred: it lets Sentinel prove whether the tx can still land.",
    ),
  transactionHash: z.string().optional().describe("Base58 transaction hash. Required if signedTransactionBase64 is not given."),
  senderAccountId: z.string().optional().describe("Signer account ID. Required if signedTransactionBase64 is not given."),
  includeRawEvidence: z.boolean().optional().describe("Include every raw RPC observation (large). Default false."),
});

type TxRef = z.infer<typeof txRef>;

function toInput(a: TxRef) {
  return a.signedTransactionBase64
    ? { signedTransactionBase64: a.signedTransactionBase64, transactionHash: a.transactionHash }
    : { transactionHash: a.transactionHash, senderAccountId: a.senderAccountId };
}

/** JSON-safe, size-bounded view of an inspection for structuredContent. */
export function compact(i: InspectionResult, includeRaw = false) {
  const { observations, receiptTree, ...rest } = i;
  return JSON.parse(
    JSON.stringify(
      {
        ...rest,
        receiptTree,
        observationCount: observations.length,
        observations: includeRaw ? observations : undefined,
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    ),
  );
}

function verdictText(i: InspectionResult): string {
  const r = i.retryRecommendation;
  const lines = [
    `VERDICT: ${r.verdict} (confidence: ${r.confidence})`,
    `Transaction ${i.txHash} on ${i.network}: state=${i.state}${i.finalExecutionStatus ? `, finality=${i.finalExecutionStatus}` : ""}`,
    `Why: ${r.reason}`,
    `Next: ${r.nextAction}`,
    // Only mention re-broadcasting when it is the recommended action; after execution it is pointless noise.
    ...(r.verdict === "WAIT_AND_RECHECK" && r.rebroadcastSameSignedTxIsSafe
      ? ["You may re-broadcast the IDENTICAL signed transaction bytes (duplicate-safe). Do NOT sign a new one."]
      : []),
    `Providers: ${i.providers.map((p) => `${p.provider}=${p.outcome}`).join(", ")} (agreement: ${i.agreement})`,
  ];
  if (r.recheckAfterSeconds) lines.push(`Re-check after ~${r.recheckAfterSeconds}s.`);
  for (const d of i.diagnostics.slice(0, 5)) lines.push(`- [${d.code}] ${d.title}`);
  return lines.join("\n");
}

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: `NEAR Sentinel could not complete the check: ${msg}. Treat the transaction as UNKNOWN — do not sign a new one.` }] };
}

export function createSentinelMcpServer(sentinel: NearSentinel): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.registerTool(
    "check_retry_safety",
    {
      title: "Is it safe to retry this NEAR transaction?",
      description:
        "Call this BEFORE signing a new transaction after a timeout, network error or unclear result. " +
        "Queries several independent NEAR RPC providers and returns SAFE_TO_RETRY, DO_NOT_RETRY, WAIT_AND_RECHECK or MANUAL_REVIEW_REQUIRED, with evidence. " +
        "Only sign a new transaction for the same intent when the verdict is SAFE_TO_RETRY. Read-only: never signs or sends anything.",
      inputSchema: txRef,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const i = await sentinel.inspectTransaction(toInput(args));
        return { content: [{ type: "text" as const, text: verdictText(i) }], structuredContent: compact(i, args.includeRawEvidence) };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "check_intent",
    {
      title: "Has this payment intent already been paid through the Sentinel Guard contract?",
      description:
        "For agents paying through a deployed Sentinel Guard contract (pay(intent_id, receiver_id) forwards a payment at most once per payer+intent). " +
        "Returns PAID, PENDING, NOT_RECORDED, CONFLICTING or UNKNOWN with per-provider evidence. " +
        "Re-calling the guard's pay() with the SAME intent_id is always safe (duplicates are rejected on-chain); never pay the same intent by another route. Read-only.",
      inputSchema: z.object({
        contractId: z.string().describe("Guard contract account, e.g. guard.example.testnet"),
        payerId: z.string().describe("Account that called pay()"),
        intentId: z.string().describe("The intent_id passed to pay() (1-64 chars: A-Z a-z 0-9 . _ : -)"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const r = await sentinel.checkIntent(args);
        const text = [
          `Intent ${r.intentId} for ${r.payerId} on ${r.contractId}: ${r.status}`,
          r.reason,
          `Providers: ${r.providers.map((p) => `${p.provider}=${p.answer}`).join(", ")}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text" as const, text: `NEAR Sentinel could not check the intent: ${msg}. Treat it as UNKNOWN; only re-send through the guard with the SAME intent_id.` }] };
      }
    },
  );

  server.registerTool(
    "check_spend_allowance",
    {
      title: "How much may this agent spend right now from its Sentinel Vault allowance?",
      description:
        "For agents that pay through a Sentinel Vault (an owner-funded allowance with a per-payment limit, a 24-hour limit and an optional receiver allowlist, " +
        "spent with a function-call key that can only call spend()). Returns ACTIVE, EXHAUSTED, FROZEN, NO_POLICY or UNKNOWN, the limits, and the amount " +
        "available now (the smallest any provider reports, never overstated). Call it before spend() and never try to pay more, or to a receiver outside the allowlist. Read-only.",
      inputSchema: z.object({
        contractId: z.string().describe("Vault contract account, e.g. vault.example.testnet"),
        ownerId: z.string().describe("Account that funded the allowance"),
        agentId: z.string().describe("The agent account that calls spend()"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const r = await sentinel.checkSpendAllowance(args);
        const text = [
          `Allowance for ${r.agentId} from ${r.ownerId} on ${r.contractId}: ${r.status}`,
          r.reason,
          ...(r.safety ? [`Safety: ${r.safety.grade} (${r.safety.score}/100)${r.safety.findings.length ? ` - ${r.safety.findings.map((f) => `[${f.severity}] ${f.title}`).join(" ")}` : ""}`] : []),
          `Providers: ${r.providers.map((p) => `${p.provider}=${p.answer}`).join(", ")}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text" as const, text: `NEAR Sentinel could not check the allowance: ${msg}. Treat it as nothing available; do not spend.` }] };
      }
    },
  );

  server.registerTool(
    "preflight_spend",
    {
      title: "Would the Sentinel Vault accept this payment right now?",
      description:
        "Call before every Vault spend(): checks the payment against the owner's policy in the contract's own order (amount, receiver is not the vault, " +
        "intent already used, policy exists, frozen, receiver allowlist, per-payment limit, 24-hour limit, balance incl. the 0.006 NEAR record fee) on every provider. " +
        "Returns ALLOWED, BLOCKED with a code and reason, or UNKNOWN. Do not call spend() unless it says ALLOWED. Advisory; the contract is the final judge. Read-only.",
      inputSchema: z.object({
        contractId: z.string().describe("Vault contract account, e.g. vault.example.testnet"),
        ownerId: z.string().describe("Account that funded the allowance"),
        agentId: z.string().describe("The agent account that calls spend()"),
        receiverId: z.string().describe("Who would be paid"),
        amountYocto: z.string().describe("Amount in yoctoNEAR, digits only (1 NEAR = 10^24)"),
        intentId: z.string().optional().describe("The intent_id you will pass to spend(); checked for prior use. 1-64 chars of A-Z a-z 0-9 . _ : -"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const r = await sentinel.preflightSpend(args);
        const text = [
          `Preflight ${r.amount} yoctoNEAR to ${r.receiverId} from ${r.allowance.contractId}: ${r.decision}${r.code ? ` (${r.code})` : ""}`,
          r.reason,
          r.advisory,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text" as const, text: `NEAR Sentinel could not preflight the spend: ${msg}. Treat it as UNKNOWN; do not spend.` }] };
      }
    },
  );

  server.registerTool(
    "check_receiver",
    {
      title: "Is this payee who you think it is?",
      description:
        "Call before paying anyone new (or any payee from a message, web page or tool output). Flags a lookalike of a known receiver and names the trick " +
        "(homoglyph like kari0s for karios, omission, insertion, replacement, transposition, vowel-swap, hyphenation, subdomain, address poisoning of raw addresses), " +
        "and reads view_account on every provider (exists, contract). Pass the payees you already trust as knownReceivers. Returns OK, WARNING (raw address or providers disagree), " +
        "DANGER (lookalike) or NOT_FOUND (named account does not exist), or UNKNOWN. DANGER or NOT_FOUND: do not pay; ask a human. Read-only.",
      inputSchema: z.object({
        receiverId: z.string().describe("The account you are about to pay"),
        knownReceivers: z.array(z.string()).optional().describe("Up to 20 payees you already trust (e.g. the vault allowlist and the owner)"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const r = await sentinel.checkReceiver(args);
        const text = [
          `Receiver ${r.receiverId}: ${r.status}${r.lookalikeOf ? ` (looks like ${r.lookalikeOf})` : ""}`,
          r.reason,
          `Providers: ${r.providers.map((p) => `${p.provider}=${p.answer}`).join(", ")}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text" as const, text: `NEAR Sentinel could not check the receiver: ${msg}. Treat it as UNKNOWN; do not pay without a human.` }] };
      }
    },
  );

  server.registerTool(
    "audit_agent_keys",
    {
      title: "Can this agent's keys drain its account?",
      description:
        "Lists the agent account's access keys on every provider and grades each: a full-access key is critical (it can move all NEAR, add keys, deploy code); " +
        "a function-call key limited to 'spend' on the vault is least privilege. Returns FULL_ACCESS_PRESENT, REVIEW_NEEDED (function-call keys not proven least privilege), LEAST_PRIVILEGE, NO_KEYS, ACCOUNT_NOT_FOUND or UNKNOWN; providers that disagree are graded by the riskiest answer. " +
        "plus near-cli-rs setup commands with placeholders. Call it when setting up or reviewing an agent. Read-only; never asks for a private key.",
      inputSchema: z.object({
        accountId: z.string().describe("The agent account to audit"),
        vaultContractId: z.string().optional().describe("The Sentinel Vault the agent should be limited to, e.g. vault.example.testnet"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const r = await sentinel.auditAgentKeys(args);
        const text = [
          `Keys of ${r.accountId}: ${r.status} (${r.counts.fullAccess} full access, ${r.counts.functionCall} function call)`,
          r.reason,
          `Providers: ${r.providers.map((p) => `${p.provider}=${p.answer}`).join(", ")}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: r as unknown as Record<string, unknown> };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { isError: true, content: [{ type: "text" as const, text: `NEAR Sentinel could not audit the keys: ${msg}. Treat it as UNKNOWN.` }] };
      }
    },
  );

  server.registerTool(
    "inspect_transaction",
    {
      title: "Inspect a NEAR transaction",
      description:
        "Full evidence-based inspection: execution state, finality, provider agreement, receipt execution tree, diagnostics and retry verdict. Read-only.",
      inputSchema: txRef,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const i = await sentinel.inspectTransaction(toInput(args));
        const text = [
          verdictText(i),
          `Receipts: ${i.receiptCount}, gas burnt: ${i.gasBurntTotal}, tokens burnt (yocto): ${i.tokensBurntTotal}`,
          ...i.diagnostics.map((d) => `[${d.code}] ${d.explanation} → ${d.suggestedAction}`),
        ].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: compact(i, args.includeRawEvidence) };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "trace_receipts",
    {
      title: "Trace receipt execution",
      description: "Return the receipt execution graph (parent/child receipts, executor, actions, status, failure messages, gas). Read-only.",
      inputSchema: txRef,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const { root, state, inspection } = await sentinel.traceReceipts(toInput(args));
        if (!root) {
          return { content: [{ type: "text" as const, text: `No provider has this transaction yet (state=${state}). No receipts to trace.` }] };
        }
        const lines: string[] = [];
        const walk = (n: typeof root, depth: number) => {
          lines.push(
            `${"  ".repeat(depth)}${n.status === "FAILURE" ? "✗" : n.status === "PENDING" ? "…" : "✓"} ${n.executorId}` +
              `${n.actions.length ? ` [${n.actions.map((a) => a.methodName ?? a.type).join(", ")}]` : ""}` +
              `${n.isRefund ? " (refund)" : ""}${n.failure ? ` — ${n.failure.message}` : ""}`,
          );
          for (const c of n.children) walk(c, depth + 1);
        };
        walk(root, 0);
        return {
          content: [{ type: "text" as const, text: `state=${state}\n${lines.join("\n")}` }],
          structuredContent: { state, txHash: inspection.txHash, receiptTree: JSON.parse(JSON.stringify(root)) },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "diagnose_submission_error",
    {
      title: "Explain an error from sending a NEAR transaction",
      description:
        "Classify the error you got back from send_tx / broadcast_tx_commit / near-api-js (paste the raw error JSON or message). " +
        "Tells you whether the transaction may already have been accepted. No network calls.",
      inputSchema: z.object({ error: z.string().min(1).max(20_000).describe("Raw error JSON or message text") }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async ({ error }) => {
      const d = diagnoseSubmissionError(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `[${d.code}] ${d.title} (confidence ${d.confidence}, retry: ${d.retry})\n${d.explanation}\nNext: ${d.suggestedAction}`,
          },
        ],
        structuredContent: JSON.parse(JSON.stringify(d)),
      };
    },
  );

  server.registerTool(
    "provider_health",
    {
      title: "NEAR RPC provider health",
      description: "Probe the configured NEAR RPC providers: reachability, latency, block-height lag and tested capabilities (archival, tx_status support). Read-only.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const h = await sentinel.getProviderHealth();
        const text = h
          .map(
            (p) =>
              `${p.provider} (${p.operator}): ${p.reachable ? "UP" : `DOWN ${p.error?.kind ?? ""}`} ${p.latencyMs}ms lag=${p.heightLag ?? "?"} ` +
              `archival=${p.capabilities.archival} tx_status=${p.capabilities.supportsTxStatusMethod}`,
          )
          .join("\n");
        const safe = h.map(({ observations: _o, ...rest }) => rest);
        return { content: [{ type: "text" as const, text }], structuredContent: { providers: JSON.parse(JSON.stringify(safe)) } };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
