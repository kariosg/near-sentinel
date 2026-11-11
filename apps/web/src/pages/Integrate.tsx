import { Card, CodeBlock as Code, linkClass } from "../components/ui";

const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8080";

export function IntegratePage() {
  return (
    <div className="space-y-4">
      <Card title="The one rule">
        <p className="text-sm text-ink-2">
          After any timeout or unclear result, <strong className="text-ink">do not sign a new transaction</strong> until Sentinel says{" "}
          <span className="font-mono text-good">SAFE_TO_RETRY</span>. Re-broadcasting the <em>identical</em> signed bytes is always duplicate-safe on NEAR;
          signing new bytes is what pays twice.
        </p>
      </Card>

      <div id="int-sdk" className="scroll-mt-24" />
      <Card title="TypeScript SDK — @near-sentinel/sdk" icon="layers">
        <Code title="agent.ts">{`import { NearSentinel } from "@near-sentinel/sdk";

const sentinel = new NearSentinel({ network: "testnet" }); // default: 4 public providers, 3 operators

// You sent a transaction and the RPC timed out. Before doing ANYTHING else:
const check = await sentinel.checkRetrySafety({
  signedTransactionBase64, // the bytes you sent (no private key inside) — enables a definitive answer
});

switch (check.verdict) {
  case "DO_NOT_RETRY":           /* it executed (or is executing) — done */ break;
  case "WAIT_AND_RECHECK":       /* may still land — re-check in check.recommendation.recheckAfterSeconds */ break;
  case "SAFE_TO_RETRY":          /* proven dead on a quorum of independent operators — sign a new tx */ break;
  case "MANUAL_REVIEW_REQUIRED": /* partial execution or conflicting evidence — escalate */ break;
}
console.log(check.recommendation.reason, check.diagnostics);`}</Code>
        <p className="mt-3 text-xs text-muted">
          Also: <span className="font-mono">inspectTransaction</span>, <span className="font-mono">traceReceipts</span>, <span className="font-mono">diagnoseFailure</span>,{" "}
          <span className="font-mono">compareProviders</span>, <span className="font-mono">getProviderHealth</span>, <span className="font-mono">subscribeToTransaction</span>,{" "}
          <span className="font-mono">exportDiagnosticReport</span>.
        </p>
      </Card>

      <div id="int-mcp" className="scroll-mt-24" />
      <Card title="AI agents — MCP server (stdio)" icon="bot" subtitle="Six read-only tools. The agent asks before it ever re-signs.">
        <Code title="shell">{`# Claude Code (after \`pnpm build\`; use the ABSOLUTE path to your clone)
claude mcp add near-sentinel -e NEAR_SENTINEL_NETWORK=testnet -- node /abs/path/to/near-sentinel/packages/mcp/dist/server.js

# Any MCP client: command = "node", args = ["/abs/path/to/near-sentinel/packages/mcp/dist/server.js"]
# Tools: check_retry_safety · inspect_transaction · trace_receipts · diagnose_submission_error · provider_health · check_intent`}</Code>
      </Card>

      <div id="int-rest" className="scroll-mt-24" />
      <Card title="REST API" icon="terminal">
        <Code title="shell">{`curl -s -X POST ${origin}/api/v1/transactions/retry-check \\
  -H 'content-type: application/json' \\
  -d '{"transactionHash":"9WeBPyuE9vC6CSTUF2iSujGq7Use1B4SrSfcPZNkRsc8","senderAccountId":"atlas.loca-swarm-mvwu8dfo.testnet"}'`}</Code>
        <p className="mt-3 text-xs text-muted">
          Interactive OpenAPI documentation:{" "}
          <a className={linkClass} href="/docs" target="_blank" rel="noreferrer">
            /docs ↗
          </a>
        </p>
      </Card>

      <div id="int-guard" className="scroll-mt-24" />
      <Card title="On-chain — Sentinel Guard contract" icon="shieldCheck">
        <p className="mb-2 text-sm text-ink-2">
          Pay through the Guard contract and a blind retry can never double-pay: a repeated <code className="font-mono text-xs">intent_id</code> from the same payer is
          rejected on-chain (<code className="font-mono text-xs">DUPLICATE_INTENT</code>) and NEAR refunds the deposit. Look up any intent on the Inspect page.
        </p>
        <Code title="shell">{`near call <guard>.testnet pay '{"intent_id":"order-42","receiver_id":"merchant.testnet"}' \\
  --deposit 1.005 --useAccount <agent>.testnet   # 1 NEAR to the merchant + 0.005 NEAR storage fee

# Read-only lookup (no keys):
curl -s '${origin}/api/v1/intents?contract=<guard>.testnet&payer=<agent>.testnet&intent=order-42'`}</Code>
      </Card>
    </div>
  );
}
