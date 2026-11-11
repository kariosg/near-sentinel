#!/usr/bin/env node
// Build the guard wasm (and optionally run the Rust unit tests) inside Docker with Rust 1.86,
// the last toolchain whose default wasm output nearcore accepts. `--cfg near` is required: without it
// near-sdk routes panics to a bare wasm trap instead of the host's panic_utf8 (readable error message).
// Output: target-docker/wasm32-unknown-unknown/release/sentinel_guard.wasm (or sentinel_vault.wasm with --crate vault)
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)));
const withTests = process.argv.includes("--test");
const crate = process.argv.includes("--crate") ? process.argv[process.argv.indexOf("--crate") + 1] : "guard";
if (!["guard", "vault"].includes(crate)) throw new Error(`unknown crate ${crate}`);
const workdir = crate === "vault" ? "/work/vault" : "/work";
const wasm = crate === "vault" ? "sentinel_vault.wasm" : "sentinel_guard.wasm";
const steps = [
  ...(withTests ? ["cargo test --locked"] : []),
  "rustup target add wasm32-unknown-unknown >/dev/null 2>&1",
  "RUSTFLAGS='--cfg near -C link-arg=-s' cargo build --locked --release --target wasm32-unknown-unknown",
  `sha256sum /work/target-docker/wasm32-unknown-unknown/release/${wasm}`,
];
execFileSync(
  "docker",
  ["run", "--rm", "-v", `${dir}:/work`, "-v", "sentinel-cargo-cache:/usr/local/cargo/registry", "-w", workdir, "-e", "CARGO_TARGET_DIR=/work/target-docker", "rust:1.86", "bash", "-c", steps.join(" && ")],
  { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
);
