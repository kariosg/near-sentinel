/**
 * SIMULATED demo — no wallet, no network, fully reproducible.
 *   node dist/simulated.js            # narrated run
 *   node dist/simulated.js --assert   # exits 1 unless outcomes are exactly as expected (used as a test)
 *
 * The signing key is generated in memory for this run and only ever touches the local mock chain.
 */
import { NearSentinel } from "@near-sentinel/sdk";
import { startFaultProxy, type Fault } from "@near-sentinel/sdk/testing";
import { KeyPair } from "near-api-js";
import { guardedAgent, naiveAgent, type AgentEnv, type AgentRun } from "./agents.js";
import { MockChain } from "./mockchain.js";

const ASSERT = process.argv.includes("--assert");
const SENDER = "agent.sim";
const RECEIVER = "merchant.sim";
const AMOUNT = 10n ** 24n; // 1 NEAR (simulated)

async function scenario(name: string, fault: Fault, which: "naive" | "guarded") {
  const kp = KeyPair.fromRandom("ed25519"); // in-memory, local mock only
  const chain = new MockChain(SENDER, RECEIVER, kp.getPublicKey().toString());
  const [a, b] = await chain.serve();
  const proxy = await startFaultProxy(a.url);
  proxy.setFault("send_tx", fault);
  const lines: string[] = [];
  const env: AgentEnv = {
    sendUrl: proxy.url,
    directUrl: a.url,
    signerId: SENDER,
    receiverId: RECEIVER,
    keyPair: kp,
    amountYocto: AMOUNT,
    timeoutMs: 1500,
    log: (l) => lines.push(l),
  };
  const sentinel = new NearSentinel({
    rpcProviders: [
      { name: "sim-provider-a", url: a.url, operator: "sim-a" },
      { name: "sim-provider-b", url: b.url, operator: "sim-b" },
    ],
    timeoutMs: 2000,
  });
  let run: AgentRun;
  try {
    run = which === "naive" ? await naiveAgent(env) : await guardedAgent(env, sentinel);
    // let any forwarded-but-unanswered submission settle on the chain
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await proxy.close();
    await a.close();
    await b.close();
  }
  return { name, which, lines, run, transfers: chain.executedTransfers, received: chain.balances.get(RECEIVER)! };
}

const results: Array<Awaited<ReturnType<typeof scenario>>> = [];
for (const [name, fault] of [
  ["Timeout, but the transfer WAS delivered", { type: "forward-then-hang" }],
  ["Timeout, and the transfer was dropped", { type: "hang" }],
] as Array<[string, Fault]>) {
  console.log(`\n━━ ${name} ━━`);
  for (const which of ["naive", "guarded"] as const) {
    const r = await scenario(name, fault, which);
    results.push(r);
    for (const l of r.lines) console.log("  " + l);
    console.log(`  ⇒ ${which.toUpperCase()}: ${r.transfers} ${r.transfers === 1 ? "transfer" : "transfers"} executed; merchant received ${Number(r.received / 10n ** 21n) / 1000} NEAR (intended: 1)\n`);
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
