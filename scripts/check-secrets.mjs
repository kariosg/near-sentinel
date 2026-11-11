#!/usr/bin/env node
/**
 * Secrets gate. Fails (exit 1) if any file that git would track contains:
 *  - a NEAR secret key   (ed25519:/secp256k1: followed by a long base58 string, in a key-like assignment)
 *  - a seed-phrase-like run of 12+ lowercase words on one line
 *  - a .env file (other than .env.example)
 * It never prints the matched secret itself, only the file and line number.
 *
 * Usage: node scripts/check-secrets.mjs            (files git would add / track)
 *
 * Outside a git checkout (e.g. the GitHub "Download ZIP" archive) it scans the folder instead, skipping
 * dependencies and build output, so `pnpm test` works for reviewers who did not clone.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const list = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "target", "target-docker", "test-results", "playwright-report", ".e2e-data", "data", "media", ".turbo", ".vite"]);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile()) out.push(join(dir, e.name).split("\\").join("/").replace(/^\.\//, ""));
  }
  return out;
}

let gitMode = true;
let files;
try {
  // Tracked + untracked-but-not-ignored files: exactly what `git add -A` would commit.
  files = [...new Set([...list(["ls-files"]), ...list(["ls-files", "--others", "--exclude-standard"])])];
} catch {
  gitMode = false; // not a git checkout (ZIP download): scan the folder
  files = walk(".");
}

const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|wasm|woff2?)$/i, /(^|\/)test\/fixtures\//];
const SECRET_KEY = /(secret|private|priv|seed|mnemonic)[\w-]*["']?\s*[:=]\s*["']?(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/i;
const BARE_KEY = /\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}\b/; // public keys are ~44 chars; secret keys ~88
const SEED = /^(?:\s*[a-z]{3,8}){12,}\s*$/; // 12+ short lowercase words and nothing else

const problems = [];
for (const f of files) {
  if (gitMode && /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: .env file would be committed`);
  if (SKIP.some((r) => r.test(f))) continue;
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    if (SECRET_KEY.test(line) || BARE_KEY.test(line)) problems.push(`${f}:${i + 1}: looks like a NEAR secret key`);
    else if (SEED.test(line)) problems.push(`${f}:${i + 1}: looks like a seed phrase`);
  });
}

if (problems.length) {
  console.error(`✗ secrets gate FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ secrets gate: ${files.length} files checked${gitMode ? "" : " (folder scan: not a git checkout)"}, no keys, seed phrases or .env files`);
