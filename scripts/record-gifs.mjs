#!/usr/bin/env node
/**
 * Records three short captioned clips of the RUNNING dashboard for the README (read-only: it only clicks through the UI):
 *   inspect-verdict  — one click on the real-money example → DO_NOT_RETRY
 *   guard-duplicate  — the Guard contract: a paid intent is PAID, a retry would be refused
 *   vault-allowance  — the Vault: how much the agent may spend now
 *   run-it-live      — the Start page replay: naive agent pays twice, guarded agent once
 *   agent-security   — the agent key check and the "would this payment be allowed?" check
 * Output: media/<name>.webm (git-ignored). Convert to docs/media/<name>.gif with the ffmpeg command below.
 *
 *   pnpm start                        # in another terminal
 *   node scripts/record-gifs.mjs      # optional: SENTINEL_URL=https://64-177-60-105.sslip.io, ONLY=<name> for one clip
 *
 * GIF: docker run --rm -v "$PWD:/w" linuxserver/ffmpeg -y -i /w/media/<name>.webm \
 *   -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
 *   /w/docs/media/<name>.gif
 */
import { createRequire } from "node:module";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const out = join(root, "media");
mkdirSync(out, { recursive: true });
const BASE = process.env.SENTINEL_URL ?? "http://127.0.0.1:8080";
const size = { width: 1280, height: 760 };
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });

async function clip(name, run) {
  if (process.env.ONLY && process.env.ONLY !== name) return;
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: out, size }, colorScheme: "dark" });
  await ctx.addInitScript(() => localStorage.setItem("sentinel.identity", JSON.stringify({ skipped: true })));
  const page = await ctx.newPage();
  const wait = (ms) => page.waitForTimeout(ms);
  const caption = async (text, ms) => {
    await page.evaluate((t) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        Object.assign(el.style, {
          position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: "9999", maxWidth: "1100px",
          padding: "12px 22px", borderRadius: "14px", textAlign: "center", background: "rgba(7,9,13,0.94)",
          border: "1px solid rgba(90,162,240,0.5)", color: "#eef1f6", font: "700 24px/1.3 'Segoe UI', system-ui, sans-serif",
        });
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
    await wait(ms);
  };
  await run(page, caption, wait);
  const video = page.video();
  await ctx.close();
  const dest = join(out, `${name}.webm`);
  renameSync(await video.path(), dest);
  console.log("saved", dest);
}

const scrollToHeading = (page, prefix) =>
  page.evaluate((p) => [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith(p))?.scrollIntoView({ block: "start" }), prefix);

await clip("inspect-verdict", async (page, caption) => {
  await page.goto(`${BASE}/#/inspect`);
  await caption("The RPC timed out. Did the payment land?", 1800);
  await page.getByRole("button", { name: "Guarded agent paid once", exact: true }).click();
  await caption("One click: a real testnet payment, checked on every provider…", 1200);
  await page.getByText("Do not retry", { exact: true }).first().waitFor({ timeout: 30000 });
  await page.evaluate(() => window.scrollTo({ top: 520 }));
  await caption("DO_NOT_RETRY: it landed. Paying again would pay twice.", 3200);
});

await clip("guard-duplicate", async (page, caption) => {
  await page.goto(`${BASE}/#/inspect`);
  await scrollToHeading(page, "Guard contract");
  await caption("Sentinel Guard: a contract that pays each intent at most once.", 1800);
  await page.getByRole("button", { name: "Paid intent" }).click();
  await page.getByText(/Already paid:/).waitFor({ timeout: 30000 });
  await caption("PAID on-chain: a retry with this intent is refused and refunded.", 3400);
});

await clip("vault-allowance", async (page, caption) => {
  await page.goto(`${BASE}/#/inspect`);
  await scrollToHeading(page, "Agent allowance");
  await caption("Sentinel Vault: give an agent an allowance, not your keys.", 1800);
  await page.getByRole("button", { name: "Live agent allowance" }).click();
  await page.getByText("Available now").first().waitFor({ timeout: 30000 });
  await page.evaluate(() => window.scrollBy({ top: 160 }));
  await caption("Limits per payment and per day, checked on every provider.", 3400);
});

await clip("run-it-live", async (page, caption, wait) => {
  await page.goto(`${BASE}/#/start`);
  await page.getByRole("button", { name: /Run it live/ }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy({ top: -120 }));
  await caption("Run it live: two agents, the same RPC timeout.", 1600);
  await page.getByRole("button", { name: /Run it live/ }).click();
  await page.getByText(/Sentinel: check 1: WAIT_AND_RECHECK/).waitFor({ timeout: 30000 });
  await page.evaluate(() => window.scrollBy({ top: 260, behavior: "smooth" }));
  await wait(600);
  await caption("Naive agent: paid twice. Sentinel-guarded agent: paid once.", 3600);
});

await clip("agent-security", async (page, caption, wait) => {
  await page.goto(`${BASE}/#/inspect?tool=keys`);
  await wait(800);
  await caption("Can this AI agent's keys drain its account?", 1800);
  await page.getByRole("button", { name: "Live demo agent keys" }).click();
  await page.getByRole("list", { name: "Access keys" }).waitFor({ timeout: 30000 });
  await page.evaluate(() => document.getElementById("tool-keys")?.querySelector("[aria-live]")?.scrollIntoView({ block: "start" }));
  await caption("Full-access key found: Sentinel shows how to give the agent a spend-only key.", 3200);
  await page.goto(`${BASE}/#/inspect?tool=vault`);
  await wait(800);
  await page.getByRole("button", { name: "Live agent allowance" }).click();
  const pre = page.locator("section", { hasText: "Would this payment be allowed?" }).last();
  await pre.waitFor({ timeout: 30000 });
  await pre.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy({ top: 120 }));
  await caption("A prompt-injected payment, checked BEFORE signing…", 1400);
  await pre.getByLabel("Receiver", { exact: true }).fill("attacker.testnet");
  await pre.getByLabel("Amount (NEAR)").fill("0.05");
  await pre.getByRole("button", { name: "Check payment" }).click();
  await pre.getByText("NOT_ALLOWED_RECEIVER").first().waitFor({ timeout: 30000 });
  await caption("BLOCKED: not on the owner's allowlist. The Vault contract enforces it on-chain too.", 3600);
});

await browser.close();
