#!/usr/bin/env node
/**
 * Secrets gate. Fails (exit 1) if any file that git would track contains:
 *  - a NEAR secret key   (ed25519:/secp256k1: followed by a long base58 string, in a key-like assignment)
 *  - a seed-phrase-like run of 12+ lowercase words on one line
 *  - a .env file (other than .env.example)
 * It never prints the matched secret itself, only the file and line number.
 *
 * Usage: node scripts/check-secrets.mjs            (files git would add / track)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const list = (args) =>
  execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

// Tracked + untracked-but-not-ignored files: exactly what `git add -A` would commit.
const files = [...new Set([...list(["ls-files"]), ...list(["ls-files", "--others", "--exclude-standard"])])];

const SKIP = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|ico|wasm|woff2?)$/i, /(^|\/)test\/fixtures\//];
const SECRET_KEY = /(secret|private|priv|seed|mnemonic)[\w-]*["']?\s*[:=]\s*["']?(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/i;
const BARE_KEY = /\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}\b/; // public keys are ~44 chars; secret keys ~88
const SEED = /^(?:\s*[a-z]{3,8}){12,}\s*$/; // 12+ short lowercase words and nothing else

const problems = [];
for (const f of files) {
  if (/(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: .env file would be committed`);
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
console.log(`✓ secrets gate: ${files.length} files checked, no keys, seed phrases or .env files`);
