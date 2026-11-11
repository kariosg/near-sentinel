#!/usr/bin/env node
// Start a throwaway local NEAR sandbox in Docker (127.0.0.1 only), run the full guard suite
// against it, then remove the container. The sandbox root key is passed to the test process
// through its environment only; it is never printed or written to disk on the host.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)));
const IMAGE = "near-sentinel-sandbox:local";
const NAME = `sentinel-guard-sandbox-${process.pid}`;
const PORT = process.env.SANDBOX_PORT ?? "3031";
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
const docker = (args, opts = {}) => execFileSync("docker", args, { env, encoding: "utf8", ...opts });

try {
  docker(["image", "inspect", IMAGE], { stdio: "ignore" });
} catch {
  console.log(`Building ${IMAGE} (one time)…`);
  docker(["build", "-t", IMAGE, join(dir, "sandbox")], { stdio: "inherit" });
}

docker(["run", "-d", "--rm", "--name", NAME, "-p", `127.0.0.1:${PORT}:3030`, IMAGE], { stdio: "ignore" });
let code = 1;
try {
  const url = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    try {
      // A ref'd timer: Docker's port proxy can accept a connection before neard listens.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(`${url}/status`, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      ready = r.ok && (await r.json()).sync_info?.latest_block_height > 2;
    } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("sandbox did not become ready within 90 s");
  const vk = JSON.parse(docker(["exec", NAME, "cat", "/data/validator_key.json"]));
  const key = vk.secret_key ?? vk.private_key;
  const r = spawnSync(process.execPath, [join(dir, "dist", "sandbox.js")], {
    stdio: "inherit",
    env: { ...process.env, SANDBOX_RPC_URL: url, SANDBOX_ROOT_KEY: key },
  });
  code = r.status ?? 1;
} catch (e) {
  console.error(`✕ ${e?.message ?? e}`);
} finally {
  try {
    docker(["stop", NAME], { stdio: "ignore" });
  } catch {}
}
process.exit(code);
