/**
 * SIMULATED demo — no wallet, no network, fully reproducible.
 *   node dist/simulated.js            # narrated run
 *   node dist/simulated.js --assert   # exits 1 unless outcomes are exactly as expected (used as a test)
 *
 * The signing key is generated in memory for this run and only ever touches the local mock chain.
 */
import { runSimulatedDemo, SCENARIOS } from "./run-simulated.js";

const ASSERT = process.argv.includes("--assert");
const results = await runSimulatedDemo();
let i = 0;
for (const [name] of SCENARIOS) {
  console.log(`
━━ ${name} ━━`);
  for (let k = 0; k < 2; k++) {
    const r = results[i++]!;
    for (const l of r.lines) console.log("  " + l);
    console.log(`  ⇒ ${r.which.toUpperCase()}: ${r.transfers} ${r.transfers === 1 ? "transfer" : "transfers"} executed; merchant received ${Number(r.received / 10n ** 21n) / 1000} NEAR (intended: 1)
`);
  }
}

console.log("SIMULATED: local mock chain + fault-injection proxy. No real network, no real funds.");

if (ASSERT) {
  const get = (scen: number, which: string) => results.find((r, i) => Math.floor(i / 2) === scen && r.which === which)!;
  const checks: Array<[string, boolean]> = [
    ["delivered: naive agent double-pays (2 transfers)", get(0, "naive").transfers === 2],
    ["delivered: guarded agent pays once (1 transfer)", get(0, "guarded").transfers === 1],
    ["delivered: guarded agent signed only 1 transaction", get(0, "guarded").run.signed.length === 1],
    ["delivered: guarded agent's first verdict is DO_NOT_RETRY", get(0, "guarded").run.decisions[0] === "check 1: DO_NOT_RETRY"],
    ["dropped: guarded agent still completes the payment (1 transfer)", get(1, "guarded").transfers === 1],
    ["dropped: guarded agent never signed new bytes", get(1, "guarded").run.signed.length === 1],
    ["dropped: guarded agent's first verdict is WAIT_AND_RECHECK", get(1, "guarded").run.decisions[0] === "check 1: WAIT_AND_RECHECK"],
  ];
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
    ok &&= pass;
  }
  process.exit(ok ? 0 : 1);
}
