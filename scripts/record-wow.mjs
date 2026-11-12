#!/usr/bin/env node
/**
 * Records a ~20 s "wow" clip of the RUNNING dashboard to media/never-pay-twice-20s.webm (git-ignored):
 * the real-money proof, the real transaction checked live (DO_NOT_RETRY), the on-chain guard rejecting a repeat.
 * Read-only: it only clicks through the UI.
 *
 *   pnpm start                       # in another terminal
 *   node scripts/record-wow.mjs      # optional: SENTINEL_URL=https://64-177-60-105.sslip.io
 *
 * Convert for X: docker run --rm -v "$PWD/media:/m" linuxserver/ffmpeg -y -i /m/never-pay-twice-20s.webm \
 *   -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an /m/never-pay-twice-20s.mp4
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
const size = { width: 1280, height: 800 };

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: out, size }, colorScheme: "dark" });
await ctx.addInitScript(() => localStorage.setItem("sentinel.identity", JSON.stringify({ skipped: true })));
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);
async function caption(text, ms) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, {
        position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", zIndex: "9999", maxWidth: "1100px",
        padding: "14px 24px", borderRadius: "14px", textAlign: "center", background: "rgba(7,9,13,0.92)",
        border: "1px solid rgba(90,162,240,0.5)", color: "#eef1f6", font: "700 26px/1.3 'Segoe UI', system-ui, sans-serif",
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await wait(ms);
}

// 0–5 s: the problem and the proof, on the first screen.
await page.goto(`${BASE}/#/start`);
await wait(700);
await caption("After an RPC timeout, an AI agent paid twice. Real testnet money.", 4300);

// 5–13 s: the same real payment, checked live by Sentinel.
await page.goto(`${BASE}/#/inspect`);
await page.getByLabel("Transaction hash").fill("C59gttNUHCaVTHVi2GKCw6zu5C7QcmwPbUuw9NeaXnzS");
await page.getByLabel("Sender account").fill("karios.testnet");
await page.getByRole("button", { name: "Inspect", exact: true }).click();
await caption("Ask NEAR Sentinel before paying again…", 1200);
await page.getByText("Do not retry", { exact: true }).first().waitFor({ timeout: 30000 });
await caption("DO_NOT_RETRY: 4 independent providers saw it land. Paid once.", 4500);

// 13–18 s: the on-chain guard.
await page.evaluate(() => [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith("Guard contract"))?.scrollIntoView({ block: "start" }));
await page.getByRole("button", { name: "Paid intent" }).click();
await page.getByText(/Already paid:/).waitFor({ timeout: 30000 });
await page.evaluate(() => {
  const el = [...document.querySelectorAll("[aria-live=polite]")].find((n) => n.textContent?.includes("Already paid"));
  if (el) window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 220 });
});
await caption("On-chain guard: a repeated intent is rejected and refunded.", 4300);

// 18–21 s: call to action.
await page.goto(`${BASE}/#/start`);
await caption("NEAR Sentinel: did the payment land? Proof before you pay again. Try it live, no wallet.", 3000);

const video = page.video();
await ctx.close();
await browser.close();
const dest = join(out, "never-pay-twice-20s.webm");
renameSync(await video.path(), dest);
console.log("saved", dest);
