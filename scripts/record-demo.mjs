#!/usr/bin/env node
/**
 * Records a captioned ~75 s walkthrough of the RUNNING dashboard to media/near-sentinel-demo.webm
 * (git-ignored), using the installed Chrome via Playwright. Read-only: it only clicks through the UI.
 *
 *   pnpm start                       # in another terminal
 *   node scripts/record-demo.mjs     # optional: SENTINEL_URL=http://127.0.0.1:8080
 *
 * Convert for X (H.264 MP4), e.g. with Docker:
 *   docker run --rm -v "$PWD/media:/m" linuxserver/ffmpeg -y -i /m/near-sentinel-demo.webm \
 *     -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an /m/near-sentinel-demo.mp4
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
const size = { width: 1440, height: 900 };

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: out, size }, colorScheme: "dark" });
await ctx.addInitScript(() => {
  localStorage.setItem("sentinel.identity", JSON.stringify({ skipped: true }));
  localStorage.removeItem("sentinel.tour");
});
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

async function caption(text, ms = 3500) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, {
        position: "fixed", left: "50%", bottom: "36px", transform: "translateX(-50%)", zIndex: "9999",
        maxWidth: "980px", padding: "14px 22px", borderRadius: "14px", textAlign: "center",
        background: "rgba(7,9,13,0.88)", border: "1px solid rgba(90,162,240,0.45)", color: "#eef1f6",
        font: "600 22px/1.35 'Segoe UI', system-ui, sans-serif", boxShadow: "0 20px 60px -20px rgba(0,0,0,.9)",
        transition: "opacity .35s ease", backdropFilter: "blur(6px)",
      });
      document.body.appendChild(el);
    }
    el.style.opacity = "0";
    setTimeout(() => { el.textContent = t; el.style.opacity = "1"; }, 200);
  }, text);
  await wait(ms);
  // Fade out so a caption never lingers into the next scene.
  await page.evaluate(() => { const el = document.getElementById("demo-caption"); if (el) el.style.opacity = "0"; });
  await wait(350);
}
const scrollTo = async (selectorOrY) => {
  await page.evaluate((s) => {
    if (typeof s === "number") window.scrollTo({ top: s, behavior: "smooth" });
    else document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, selectorOrY);
  await wait(1200);
};

// 1. Start page
await page.goto(`${BASE}/#/start`);
await wait(1500);
await caption("AI agents on NEAR re-sign after an RPC timeout — and can pay twice.", 4200);
await caption("NEAR Sentinel tells the agent, with evidence, whether a retry is safe.", 4000);
await scrollTo("#why-title");
await caption("Same timeout: the naive agent paid 2 NEAR. The Sentinel-guarded agent paid 1.", 4500);
await scrollTo("#tour");
await caption("Judges get a one-click, 3-minute tour. No wallet needed.", 3500);

// 2. Real partially-completed testnet transaction
await page.getByRole("link", { name: /Run it: Inspect a real testnet transaction/ }).click();
await caption("A real testnet transaction: top-level success, but two contract calls failed.", 3000);
await page.getByText("Manual review required").waitFor({ timeout: 30000 });
await wait(600);
await caption("Sentinel: MANUAL_REVIEW_REQUIRED — cross-checked on 4 independent RPC providers.", 4500);
await page.evaluate(() => [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith("Provider evidence"))?.scrollIntoView({ behavior: "smooth", block: "center" }));
await wait(1200);
await caption("Per-provider evidence: who found it, at what finality, how fast.", 3800);
await page.evaluate(() => [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith("Receipt execution graph"))?.scrollIntoView({ behavior: "smooth", block: "start" }));
await wait(1200);
await caption("The receipt graph pinpoints the failed ft_burn that top-level status hides.", 4500);

// 3. Fault benchmark
await page.goto(`${BASE}/#/benchmarks?run=simulated`);
await caption("12 fault scenarios: timeouts, resets, malformed replies, lying or lagging providers…", 3500);
await page.getByText(/12 \/ 12 scenarios produced the expected classification/).waitFor({ timeout: 60000 });
await caption("12 / 12 classified correctly. Unknown is never reported as safe.", 4200);

// 4. Providers
await page.goto(`${BASE}/#/providers`);
await wait(1200);
await caption("Every provider capability is tested live — not trusted from its own status.", 4200);

// 5. Integrate (MCP)
await page.goto(`${BASE}/#/integrate`);
await wait(800);
await scrollTo("#int-mcp");
await caption("Agents call check_retry_safety over MCP before they ever sign again.", 4200);

// 6. Guard contract
await scrollTo("#int-guard");
await caption("Sentinel Guard: a NEAR contract that pays at most once per intent, enforced on-chain.", 4500);

// 6b. The live testnet deployment
await page.goto(`${BASE}/#/inspect`);
await wait(800);
await page.evaluate(() => [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith("Guard contract"))?.scrollIntoView({ behavior: "smooth", block: "start" }));
await wait(1200);
await page.getByRole("button", { name: "Paid intent" }).click();
await page.getByText(/Already paid:/).waitFor({ timeout: 30000 });
// Bring the verdict and the per-provider table above the caption bar.
await page.evaluate(() => {
  const el = [...document.querySelectorAll("[aria-live=polite]")].find((n) => n.textContent?.includes("Already paid"));
  if (el) window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 260, behavior: "smooth" });
});
await wait(1000);
await caption("Live on testnet: this intent was paid once — all 4 providers agree, so a retry would be rejected.", 4800);

// 7. Command palette + close
await page.keyboard.press("Control+k");
await wait(600);
await page.keyboard.type("bench", { delay: 90 });
await caption("Ctrl+K jumps anywhere.", 2200);
await page.keyboard.press("Escape");

// 8. Outro
await page.goto(`${BASE}/#/start`);
await wait(1200);
await caption("NEAR Sentinel — read-only, open source, built at NEAR HACKATHON.", 4500);
await wait(800);

const video = page.video();
await ctx.close();
await browser.close();
const p = await video.path();
const dest = join(out, "near-sentinel-demo.webm");
renameSync(p, dest);
console.log("saved", dest);
