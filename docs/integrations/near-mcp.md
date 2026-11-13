# Use NEAR Sentinel next to the official NEAR MCP Server

NEAR's docs list an MCP server among the tools for AI agents ([docs.near.org/ai](https://docs.near.org/ai/introduction)).
That server lets an agent act on NEAR. NEAR Sentinel's MCP server is the read-only safety check that runs beside it.

| Server | Role |
|---|---|
| NEAR MCP Server (official, [`@nearai/near-mcp`](https://github.com/nearai/near-mcp)) | Acts on NEAR with the agent's keys: e.g. `tokens_send_near`, `contract_call_raw_function`. It has no tool to check a transaction's status after a timeout. |
| `near-sentinel` (this repo) | Read-only, holds no keys. Answers "did it land?", "is it safe to pay again?", "may I spend this?". |

## The rule

**The agent calls `near-sentinel` before any resend or re-sign.** After a timeout or unclear result it calls
`check_retry_safety` and acts on the verdict (`DO_NOT_RETRY`, `WAIT_AND_RECHECK`, `SAFE_TO_RETRY`,
`MANUAL_REVIEW_REQUIRED`). Before paying from a Sentinel Vault it calls `preflight_spend` (or `check_spend_allowance` for the overall picture), `check_receiver` flags a lookalike or poisoned receiver before a new payee is paid, and `audit_agent_keys` checks that the agent holds no full-access key.
The full procedure is in the Agent Skill: [skills/near-sentinel/SKILL.md](../../skills/near-sentinel/SKILL.md).

## Example MCP client config (two servers)

```json
{
  "mcpServers": {
    "near-mcp": {
      "command": "npx",
      "args": ["-y", "@nearai/near-mcp@latest", "run"],
      "env": {}
    },
    "near-sentinel": {
      "command": "node",
      "args": ["/abs/path/to/near-sentinel/packages/mcp/dist/server.js"],
      "env": { "NEAR_SENTINEL_NETWORK": "testnet" }
    }
  }
}
```

`near-mcp` is NEAR's official server ([github.com/nearai/near-mcp](https://github.com/nearai/near-mcp)); it holds keys and sends transactions. `near-sentinel` stays read-only and fills the gap it leaves: after a timeout, did the transaction land, and is it safe to send again? Build it with `pnpm install && pnpm build` first.

## Why NEAR's own guidance leads here

- NEAR's RPC error docs describe `TIMEOUT_ERROR`: the request timed out, and the transaction may still be processed
  ([docs.near.org/api/rpc/errors](https://docs.near.org/api/rpc/errors)).
- NEAR's transaction docs describe `wait_until` levels and looking up a transaction's status by hash and sender
  ([docs.near.org/api/rpc/transactions](https://docs.near.org/api/rpc/transactions)).

Those docs give the building blocks. Sentinel turns them into one decision: it asks several independent
RPC providers, and proves `SAFE_TO_RETRY` only when the original can never land (its nonce was used or its
validity window expired, on at least two independent operators). Unknown is never reported as safe.

## See also

- MCP tools and setup: [README → From an AI agent (MCP)](../../README.md#from-an-ai-agent-mcp)
- An agent on NEAR AI Cloud that uses Sentinel as binding tools: [examples/near-ai-agent](../../examples/near-ai-agent)
