/**
 * The simulated naive-vs-guarded demo as a library: a local mock chain plus a fault-injection proxy that
 * delivers the transfer but never answers. No network, no real funds; the signing key lives in memory for
 * one run and only ever touches the local mock chain. Used by the CLI (simulated.ts) and the API's demo route.
 */
import { NearSentinel } from "@near-sentinel/sdk";
import { startFaultProxy, type Fault } from "@near-sentinel/sdk/testing";
import { KeyPair } from "near-api-js";
import { guardedAgent, naiveAgent, type AgentEnv, type AgentRun } from "./agents.js";
import { MockChain } from "./mockchain.js";

const SENDER = "agent.sim";
const RECEIVER = "merchant.sim";
const AMOUNT = 10n ** 24n; // 1 NEAR (simulated)

export async function scenario(name: string, fault: Fault, which: "naive" | "guarded") {
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

export const SCENARIOS: Array<[string, Fault]> = [
  ["Timeout, but the transfer WAS delivered", { type: "forward-then-hang" }],
  ["Timeout, and the transfer was dropped", { type: "hang" }],
];

export type DemoResult = Awaited<ReturnType<typeof scenario>>;

/** Runs both scenarios for both agents, in order: [delivered/naive, delivered/guarded, dropped/naive, dropped/guarded]. */
export async function runSimulatedDemo(): Promise<DemoResult[]> {
  const results: DemoResult[] = [];
  for (const [name, fault] of SCENARIOS) for (const which of ["naive", "guarded"] as const) results.push(await scenario(name, fault, which));
  return results;
}
