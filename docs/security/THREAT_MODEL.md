# Threat model

**Assets:**
- The correctness of verdicts. A wrong `SAFE_TO_RETRY` can cause a double payment.
- The API host and its network: SSRF targets.
- API keys.
- Availability.

| Threat | Mitigation | Residual risk |
|---|---|---|
| **A provider lies or lags**, e.g. says "unknown" for an executed tx | Positive evidence wins. `SAFE_TO_RETRY` needs per-node proof from ≥ 2 distinct operators. Answers for a different hash are rejected. Conflicting executed outcomes → manual review. | Collusion of ≥ 2 independent operators, all of whom also hold the history window. Raise `MIN_INDEPENDENT_OPERATORS` or add your own node. No light-client proofs (see the `proven` project in research). |
| **Provider lag between nonce read and lookup** | The nonce is read **before** the second lookup, and both come from the same node (ordering asserted in tests). | — |
| **Access key deleted and re-added** | A missing key is never treated as proof. | — |
| **Clock / block-time assumptions** | Expiry uses block heights, not time. Block time is measured and used only for ETA text. | — |
| **SSRF via custom provider URLs** | URL policy plus connect-time IP check (DNS rebinding). No redirects. Chain-id check. API key required. | An attacker with an API key can make the server send `status` requests to public hosts. |
| **Oversized / malicious responses** | Streamed byte cap; JSON parse in try/catch; structural validation. | — |
| **Resource exhaustion** | Rate limits; stricter limit on fan-out routes; single-flight for identical inspections; one benchmark at a time; SSE connection cap (200). | A distributed attacker with many IPs. Put a reverse proxy / WAF in front for public deployments. |
| **API key leakage** | Digests only in config; constant-time compare; redacted logs; fail closed. | Keys sent over plain HTTP if TLS isn't terminated in front. |
| **Prompt injection through MCP tool output** (e.g. hostile strings in contract logs) | Tools return data, not instructions. Verdicts come from deterministic rules, not from log text. | An agent's own handling of tool text is outside Sentinel's control. |
| **Demo key misuse** | Git-ignored `.env`; never printed; testnet chain-id gate; amount cap; dry run by default. | The operator's own machine security. |
