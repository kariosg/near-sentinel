#!/usr/bin/env node
/**
 * near-sentinel-mcp — stdio MCP server.
 * stdout carries the MCP protocol; ALL logging goes to stderr.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sentinelFromEnv } from "./config.js";
import { createSentinelMcpServer, SERVER_VERSION } from "./tools.js";

const sentinel = await sentinelFromEnv();
process.stderr.write(
  `[near-sentinel-mcp ${SERVER_VERSION}] network=${sentinel.network} providers=${sentinel.providers.map((p) => p.name).join(",")} (read-only)\n`,
);
serveStdio(() => createSentinelMcpServer(sentinel), {
  onerror: (e) => process.stderr.write(`[near-sentinel-mcp] ${e.message}\n`),
});
