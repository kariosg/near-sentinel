#!/usr/bin/env node
/**
 * Re-renders the brand PNGs from the source of truth, so they never drift from the logo:
 *   apps/web/public/apple-touch-icon.png  (180×180, from apps/web/public/favicon.svg)
 *   apps/web/public/og.png                (1200×630 share card: a screenshot of the Start page)
 *
 *   node scripts/render-brand.mjs [base-url]      default http://127.0.0.1:8080 (run `pnpm build && pnpm start` first)
 *
 * Uses the Playwright Chromium installed for the browser tests. Read-only against the app.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const base = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const pub = join(root, "apps/web/public");

const browser = await chromium.launch();
try {
  // Apple touch icon: iOS rounds the corners itself, so render the mark on a full square of the tile colour.
  // The thin rim is for small sizes on dark UI; drop it here, and square the tile so iOS's own rounding looks clean.
  const svg = readFileSync(join(pub, "favicon.svg"), "utf8")
    .replace(/<rect x="\.5"[^>]*\/>/, "")
    .replace('rx="9"', 'rx="0"');
  const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
  await icon.setContent(`<html><body style="margin:0;background:#065f46">${svg.replace("<svg ", '<svg width="180" height="180" ')}</body></html>`);
  await icon.screenshot({ path: join(pub, "apple-touch-icon.png") });

  // Share card: the Start page as a first-time visitor sees it, with the optional identity banner skipped.
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => localStorage.setItem("sentinel.identity", JSON.stringify({ skipped: true })));
  await page.goto(`${base}/#/start`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500); // let the entry animations finish
  await page.screenshot({ path: join(pub, "og.png") });
  console.log("wrote apple-touch-icon.png and og.png");
} finally {
  await browser.close();
}
