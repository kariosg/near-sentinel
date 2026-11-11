import type { NearSentinel } from "@near-sentinel/sdk";
import type { KeyPair } from "near-api-js";
import { accessKeyNonceAndBlock, sendTx, signTransfer, type Signed } from "./tx.js";

export interface AgentEnv {
  /** Path used for the FIRST submission (in the demo: through the fault-injection proxy). */
  sendUrl: string;
  /** Healthy endpoint used for reads, retries and re-broadcasts. */
  directUrl: string;
  signerId: string;
  receiverId: string;
  keyPair: KeyPair;
  amountYocto: bigint;
  /** Client-side deadline for a submission, like any agent HTTP tool. */
  timeoutMs: number;
  log: (line: string) => void;
}

export interface AgentRun {
  agent: "naive" | "guarded";
  signed: Signed[];
  decisions: string[];
}

async function signNext(env: AgentEnv, nonceOverride?: bigint): Promise<Signed> {
  const { nonce, blockHash } = await accessKeyNonceAndBlock(env.directUrl, env.signerId, env.keyPair.getPublicKey().toString());
  return signTransfer({
    keyPair: env.keyPair,
    signerId: env.signerId,
    receiverId: env.receiverId,
    nonce: nonceOverride ?? nonce + 1n,
    amountYocto: env.amountYocto,
    blockHash,
  });
}

/**
 * The common, dangerous pattern: "it timed out, so it failed — try again".
 * Re-signs with the next nonce (as a local nonce cache would) and sends again.
 */
export async function naiveAgent(env: AgentEnv): Promise<AgentRun> {
  const run: AgentRun = { agent: "naive", signed: [], decisions: [] };
  const first = await signNext(env);
  run.signed.push(first);
  env.log(`[naive]   signed transfer #1 ${first.hash} (nonce ${first.nonce}); sending…`);
  const r1 = await sendTx(env.sendUrl, first.base64, env.timeoutMs);
  if (r1.kind === "ok") {
    run.decisions.push("first send confirmed");
    return run;
  }
  env.log(`[naive]   send #1 → ${r1.kind === "timeout" ? `TIMEOUT after ${env.timeoutMs} ms` : "error"}. "It failed — retrying."`);
  run.decisions.push(`first send ${r1.kind}; re-signed and re-sent`);
  const second = await signNext(env, first.nonce + 1n);
  run.signed.push(second);
  env.log(`[naive]   signed transfer #2 ${second.hash} (nonce ${second.nonce}); sending…`);
  const r2 = await sendTx(env.directUrl, second.base64, 60_000);
  env.log(`[naive]   send #2 → ${r2.kind}`);
  return run;
}

/**
 * Same agent, but it asks NEAR Sentinel before signing anything new, and follows the verdict.
 */
export async function guardedAgent(env: AgentEnv, sentinel: NearSentinel, maxChecks = 12): Promise<AgentRun> {
  const run: AgentRun = { agent: "guarded", signed: [], decisions: [] };
  const first = await signNext(env);
  run.signed.push(first);
  env.log(`[guarded] signed transfer #1 ${first.hash} (nonce ${first.nonce}); sending…`);
  const r1 = await sendTx(env.sendUrl, first.base64, env.timeoutMs);
  if (r1.kind === "ok") {
    run.decisions.push("first send confirmed");
    return run;
  }
  env.log(`[guarded] send #1 → ${r1.kind === "timeout" ? `TIMEOUT after ${env.timeoutMs} ms` : "error"}. Asking NEAR Sentinel before doing anything…`);

  let rebroadcasted = false;
  for (let i = 0; i < maxChecks; i++) {
    const c = await sentinel.checkRetrySafety({ signedTransactionBase64: first.base64 });
    const rec = c.recommendation;
    env.log(`[guarded] Sentinel: ${c.verdict} (${rec.confidence}) — state ${c.state}; providers ${c.inspection.providers.map((p) => `${p.provider}=${p.outcome}`).join(", ")}`);
    run.decisions.push(`check ${i + 1}: ${c.verdict}`);
    if (c.verdict === "DO_NOT_RETRY") {
      env.log(`[guarded] → Not retrying. ${rec.reason}`);
      return run;
    }
    if (c.verdict === "MANUAL_REVIEW_REQUIRED") {
      env.log(`[guarded] → Escalating to a human. ${rec.reason}`);
      return run;
    }
    if (c.verdict === "SAFE_TO_RETRY") {
      const second = await signNext(env);
      run.signed.push(second);
      env.log(`[guarded] → Proven safe. Signed a NEW transfer ${second.hash}; sending…`);
      await sendTx(env.directUrl, second.base64, 60_000);
      return run;
    }
    // WAIT_AND_RECHECK: the original may still land. Never sign new bytes; re-broadcasting the SAME bytes is duplicate-safe.
    if (rec.rebroadcastSameSignedTxIsSafe && !rebroadcasted) {
      rebroadcasted = true;
      env.log("[guarded] → May still land. Re-broadcasting the IDENTICAL signed bytes (duplicate-safe), not signing a new transaction.");
      const rb = await sendTx(env.directUrl, first.base64, 30_000);
      env.log(`[guarded]   re-broadcast → ${rb.kind}`);
      run.decisions.push(`re-broadcast same bytes: ${rb.kind}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(1, rec.recheckAfterSeconds ?? 3) * 1000));
  }
  env.log("[guarded] → Still unresolved after the check budget. Escalating; no new transaction signed.");
  return run;
}
