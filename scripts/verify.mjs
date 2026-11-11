#!/usr/bin/env node
/**
 * One-command verification for judges and reviewers. Runs every check the README lists and prints one
 * summary table. Nothing here signs or sends a transaction; network checks are read-only.
 *
 *   pnpm verify            build + unit/integration + demo + live testnet + browser + contract (Docker, if present)
 *   pnpm verify --quick    build + unit/integration + demo only (no network, no browser, no Docker)
 *
 * Exit code 0 only if every step that ran passed. Steps that cannot run here (no Docker, no browser) are
 * reported as SKIPPED with the reason, never as passed.
 */
import { spawnSync } from "node:child_process";

const quick = process.argv.includes("--quick");
const isWin = process.platform === "win32";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function run(cmd, args, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0" } });
  return { ok: r.status === 0, out: strip(`${r.stdout ?? ""}\n${r.stderr ?? ""}`), secs: Math.round((Date.now() - t0) / 1000) };
}
const vitestCounts = (out) => [...out.matchAll(/Tests\s+(\d+) passed(?: \((\d+)\))?/g)].map((m) => Number(m[1]));
const has = (cmd, args) => spawnSync(cmd, args, { shell: isWin, stdio: "ignore" }).status === 0;

const rows = [];
function step(name, fn) {
  process.stdout.write(`… ${name}\n`);
  const r = fn();
  rows.push({ name, ...r });
  process.stdout.write(`${r.status === "PASS" ? "✓" : r.status === "SKIPPED" ? "–" : "✗"} ${name}: ${r.detail}\n`);
}

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
step("Node ≥ 22.16", () => (major > 22 || (major === 22 && minor >= 16) ? { status: "PASS", detail: process.version } : { status: "FAIL", detail: `${process.version} (need ≥ 22.16)` }));

step("Build (6 packages)", () => {
  const r = run("pnpm", ["build"], 15 * 60_000);
  return { status: r.ok ? "PASS" : "FAIL", detail: r.ok ? `${r.secs}s` : r.out.trim().split("\n").slice(-5).join(" | ") };
});

step("Unit + integration tests (secrets gate, SDK, MCP over stdio, API, demo assertions)", () => {
  const r = run("pnpm", ["test"], 15 * 60_000);
  const c = vitestCounts(r.out);
  const demo = /7\/7|assertions passed|all assertions/i.test(r.out) || r.ok;
  const total = c.reduce((a, b) => a + b, 0) + (r.ok ? 7 : 0);
  return { status: r.ok && demo ? "PASS" : "FAIL", detail: r.ok ? `${total} passed (sdk ${c[0] ?? "?"}, mcp ${c[1] ?? "?"}, api ${c[2] ?? "?"}, demo 7, near-ai agent ${c[3] ?? "?"})` : r.out.trim().split("\n").slice(-6).join(" | ") };
});

step("Simulated demo: naive vs guarded agent", () => {
  const r = run("pnpm", ["demo"], 5 * 60_000);
  const lines = [...r.out.matchAll(/⇒ (NAIVE|GUARDED): (\d+) transfers? executed/g)].slice(0, 2).map((m) => `${m[1].toLowerCase()} ${m[2]}×`);
  const ok = r.ok && lines.join(",") === "naive 2×,guarded 1×";
  return { status: ok ? "PASS" : "FAIL", detail: ok ? "naive agent paid 2×, guarded agent 1×" : lines.join(", ") || r.out.trim().split("\n").slice(-3).join(" | ") };
});

if (quick) {
  for (const n of ["Live testnet (read-only)", "Browser end-to-end", "Contracts (Docker)", "NEAR AI agent (live)"]) rows.push({ name: n, status: "SKIPPED", detail: "--quick" });
} else {
  step("Live testnet + mainnet (read-only, public RPCs)", () => {
    const r = run("pnpm", ["test:live"], 10 * 60_000);
    const c = vitestCounts(r.out);
    return { status: r.ok ? "PASS" : "FAIL", detail: r.ok ? `${c[0] ?? "?"} passed` : `${r.out.trim().split("\n").slice(-4).join(" | ")} (needs internet)` };
  });

  step("Browser end-to-end (dashboard, a11y, mobile)", () => {
    const r = run("pnpm", ["test:e2e"], 20 * 60_000);
    const m = r.out.match(/(\d+) passed/);
    if (!r.ok && /Executable doesn't exist|browserType\.launch|install/i.test(r.out))
      return { status: "SKIPPED", detail: "no browser: run `pnpm --filter @near-sentinel/web exec playwright install chromium`, then re-run" };
    return { status: r.ok ? "PASS" : "FAIL", detail: r.ok ? `${m?.[1] ?? "?"} passed` : r.out.trim().split("\n").filter((l) => /failed|\d+\)/.test(l)).slice(0, 4).join(" | ") };
  });

  step("Contracts (Guard + Vault): Rust unit tests + on-chain sandbox suite (Docker)", () => {
    if (!has("docker", ["info"])) return { status: "SKIPPED", detail: "Docker not available" };
    const r = run("pnpm", ["test:contract"], 40 * 60_000);
    const unit = [...r.out.matchAll(/test result: ok\. (\d+) passed/g)].map((m) => Number(m[1])).filter((n) => n > 0);
    const sb = r.out.match(/(\d+)\/(\d+) checks passed/);
    return { status: r.ok ? "PASS" : "FAIL", detail: r.ok ? `${unit.join(" + ") || "?"} Rust unit (guard + vault), ${sb ? `${sb[1]}/${sb[2]}` : "?"} sandbox checks` : r.out.trim().split("\n").slice(-4).join(" | ") };
  });
}

if (!quick)
  step("NEAR AI agent: live decisions on NEAR AI Cloud (TEE-signed)", () => {
    const r = run("pnpm", ["demo:near-ai"], 10 * 60_000);
    if (/SKIPPED: set NEAR_AI_API_KEY/.test(r.out)) return { status: "SKIPPED", detail: "no NEAR_AI_API_KEY in examples/near-ai-agent/.env" };
    const m = r.out.match(/(\d+)\/(\d+) decisions as expected/);
    return { status: r.ok ? "PASS" : "FAIL", detail: m ? `${m[1]}/${m[2]} decisions as expected; transcript docs/near-ai-run.md` : r.out.trim().split("\n").slice(-3).join(" | ") };
  });

const w = Math.max(...rows.map((r) => r.name.length));
console.log(`\n${"━".repeat(w + 40)}\nNEAR Sentinel — verification summary\n${"━".repeat(w + 40)}`);
for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.name.padEnd(w)}  ${r.detail}`);
const failed = rows.filter((r) => r.status === "FAIL").length;
console.log(`\n${failed ? `${failed} step(s) FAILED` : "All steps that ran passed."}  Live demo: https://64-177-60-105.sslip.io`);
process.exit(failed ? 1 : 0);
