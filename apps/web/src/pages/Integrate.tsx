import { SecurityCard } from "../components/SecurityCard";
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
      <Card title="AI agents — MCP server (stdio)" icon="bot" subtitle="Ten read-only tools. The agent asks before it ever re-signs or spends.">
        <Code title="shell">{`# Claude Code (after \`pnpm build\`; use the ABSOLUTE path to your clone)
claude mcp add near-sentinel -e NEAR_SENTINEL_NETWORK=testnet -- node /abs/path/to/near-sentinel/packages/mcp/dist/server.js

# Any MCP client: command = "node", args = ["/abs/path/to/near-sentinel/packages/mcp/dist/server.js"]
# Tools: check_retry_safety · inspect_transaction · trace_receipts · diagnose_submission_error · provider_health · check_intent · check_spend_allowance · preflight_spend · audit_agent_keys · check_receiver`}</Code>
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
          rejected on-chain (<code className="font-mono text-xs">DUPLICATE_INTENT</code>) and NEAR refunds the deposit. Live on testnet as{" "}
          <a className={linkClass} href="https://testnet.nearblocks.io/address/guard.karios.testnet" target="_blank" rel="noreferrer">guard.karios.testnet</a>; look up any intent on the Inspect page.
        </p>
        <Code title="shell">{`near call guard.karios.testnet pay '{"intent_id":"order-42","receiver_id":"merchant.testnet"}' \\
  --deposit 1.005 --useAccount <agent>.testnet   # 1 NEAR to the merchant + 0.005 NEAR storage fee

# Read-only lookup (no keys) — a real intent paid on testnet:
curl -s '${origin}/api/v1/intents?contract=guard.karios.testnet&payer=karios.testnet&intent=tmwbtoqi6-a'`}</Code>
      </Card>

      <div id="int-vault" className="scroll-mt-24" />
      <Card title="On-chain — Sentinel Vault: money for an agent, not keys" icon="wallet">
        <p className="mb-2 text-sm text-ink-2">
          The owner funds an allowance with a per-payment limit, a 24-hour limit and a receiver allowlist. The agent holds only a{" "}
          <strong>function-call key</strong> that can call <code className="font-mono text-xs">spend</code> on the vault: it can pay within the policy, once per
          intent, and cannot move its own NEAR or call anything else. Live on testnet as{" "}
          <a className={linkClass} href="https://testnet.nearblocks.io/address/vault.karios.testnet" target="_blank" rel="noreferrer">vault.karios.testnet</a>.
        </p>
        <Code title="shell">{`# Owner: fund an allowance (1 NEAR per payment, 3 NEAR per day, only to the merchant)
near call vault.karios.testnet set_policy '{"agent_id":"<agent>.testnet","allowed_receivers":["merchant.testnet"],
    "per_payment_max":"1000000000000000000000000","daily_max":"3000000000000000000000000"}' \\
  --deposit 5 --useAccount <owner>.testnet

# Owner: give the agent a key that can ONLY call spend() on the vault (no deposit, gas allowance only)
near account add-key <agent>.testnet grant-function-call-access --allowance '0.25 NEAR' \\
  --contract-account-id vault.karios.testnet --function-names spend autogenerate-new-keypair save-to-legacy-keychain \\
  network-config testnet sign-with-legacy-keychain send

# Agent: before paying, ask how much it may spend now (read-only, every provider)
curl -s '${origin}/api/v1/allowance?contract=vault.karios.testnet&owner=karios.testnet&agent=kariosr.testnet'

# Agent: would THIS payment be allowed? (the Vault's own rules, before signing; amount in yoctoNEAR)
curl -s '${origin}/api/v1/spend-preflight?contract=vault.karios.testnet&owner=karios.testnet&agent=kariosr.testnet&receiver=karios.testnet&amount=1000000000000000000000'

# Agent: is this receiver a scam lookalike of a known payee? (before paying anyone new)
curl -s '${origin}/api/v1/receiver-check?receiver=kari0s.testnet&known=karios.testnet'

# Owner: can this agent's keys drain its account?
curl -s '${origin}/api/v1/agent-keys?account=kariosr.testnet&vault=vault.karios.testnet'`}</Code>
      </Card>

      <div id="int-security" className="scroll-mt-24" />
      <SecurityCard />

      <Card title="Use it in your project — and how it stays sustainable" icon="layers">
        <div className="grid gap-5 text-sm text-ink-2 md:grid-cols-2">
          <div>
            <p className="font-medium text-ink">Integrate today</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                <strong className="text-ink">MCP server</strong> or <strong className="text-ink">Agent Skill</strong> for AI agents
              </li>
              <li>
                <strong className="text-ink">TypeScript SDK</strong> for wallets, payment apps and bots
              </li>
              <li>
                <strong className="text-ink">REST API</strong> (Docker image): self-host, or use a hosted instance
              </li>
              <li>
                <strong className="text-ink">Guard / Vault contracts</strong> for pay-once and agent allowances on-chain
              </li>
            </ul>
            <p className="mt-2 text-xs text-muted">Open source (MIT): the core stays free and self-hostable.</p>
          </div>
          <div>
            <p className="font-medium text-ink">Revenue: none today, but a clear model exists</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Hosted API: free tier for builders, paid plans by number of checks (API keys are already supported)</li>
              <li>Enterprise and self-hosted support: SLAs, custom provider sets, private deployments</li>
              <li>Optional, transparent on-chain fee in Guard / Vault (today they charge only NEAR storage)</li>
              <li>Ecosystem grants: payment safety is public-good infrastructure for NEAR&apos;s agent economy</li>
            </ul>
            <p className="mt-2 text-xs text-muted">
              Low running cost: read-only, no keys, an embedded SQLite file; the live instance runs on a 1 GB server.{" "}
              <a className={linkClass} href="https://github.com/kariosg/near-sentinel#integration-sustainability-and-business-model" target="_blank" rel="noreferrer">
                Details
              </a>
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
