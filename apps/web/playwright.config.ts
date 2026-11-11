import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against a REAL running Sentinel API (which serves the built dashboard) on NEAR testnet.
 * If nothing is listening on SENTINEL_URL, Playwright starts the built API itself.
 */
const url = process.env.SENTINEL_URL ?? "http://127.0.0.1:8080";

/** Installed Google Chrome is preferred; without it, fall back to Playwright's bundled Chromium (`npx playwright install chromium`). */
const chromeInstalled = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
].some((p) => existsSync(p));
const channel = process.env.PW_CHANNEL ?? (chromeInstalled ? "chrome" : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  // Uses the installed Google Chrome (channel "chrome") when present, otherwise Playwright's bundled Chromium.
  // Set PW_CHANNEL to force a channel.
  use: { baseURL: url, viewport: { width: 1360, height: 900 }, colorScheme: "dark", channel, headless: true },
  // The whole suite is one very fast "user" from one IP, so the per-IP limits are raised for E2E only.
  webServer: {
    command: "node --no-warnings=ExperimentalWarning ../api/dist/server.js",
    url: `${url}/health`,
    reuseExistingServer: true,
    timeout: 60_000,
    env: { PORT: new URL(url).port || "8080", HOST: "127.0.0.1", METRICS_PORT: "0", LOG_LEVEL: "warn", DATA_DIR: "./.e2e-data", RATE_LIMIT_MAX: "2000", INSPECT_RATE_LIMIT_MAX: "500" },
  },
});
