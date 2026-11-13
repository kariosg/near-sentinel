# Progress

Mapped to the phases of the original brief. Detailed gate results: [STATUS.md](STATUS.md).

| Phase | Status | Evidence |
|---|---|---|
| 0. Research and competitor audit | Done | [COMPETITOR_RESEARCH.md](COMPETITOR_RESEARCH.md), [VERDICT.md](VERDICT.md); live RPC probes |
| 1. Architecture and spec | Done (scope narrowed deliberately) | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), [architecture/](architecture/) |
| 2. Backend and RPC integration | Done | `packages/sdk/src/rpc.ts`, `apps/api` |
| 3. Transaction and receipt engine | Done | `outcome.ts`; real-fixture tests |
| 4. Diagnostics and retry safety | Done | `diagnostics.ts`, `retry.ts`; 19-case decision table; mutation check |
| 5. TypeScript SDK | Done (not published to npm) | `packages/sdk`; built `dist` imported from outside the repo |
| 6. Dashboard | Done | `apps/web`; 59/59 Playwright E2E; screenshots |
| 7. Benchmark and fault simulation | Done | 12/12 simulated scenarios; real 30-sample benchmark |
| 8. Security and testing | Done | [SECURITY.md](../SECURITY.md), [threat model](security/THREAT_MODEL.md); `pnpm audit` clean |
| 9. Documentation and deployment | Done | README, docs/, Dockerfile, compose; SIGTERM, persistence and backup verified in Docker |
| 10. Final production-readiness audit | Done | All gates re-run on a clean build; see [STATUS.md](STATUS.md) |

**Additions beyond the brief, chosen for the hackathon track (AI Security & Defense):**
- An MCP server for agents.
- The naive vs guarded agent demo.

**Not built, with the reason:**
- Postgres/Redis: SQLite (built-in `node:sqlite`) is enough for a single instance.
- OpenTelemetry: Prometheus and pino logs are enough for one instance.
- API-key management UI: keys come from env digests.
- A full receipt explorer: NearBlocks already has one.
- Separate worker and docs apps: the prober runs in the API process, and docs are Markdown plus OpenAPI.

The full list is in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
