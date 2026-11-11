/**
 * Dashboard E2E against the real API + NEAR testnet (read-only).
 * Every test fails on any browser console error. Screenshots are written to docs/screenshots/.
 */
import { expect, test, type Page } from "@playwright/test";

const SHOTS = "../../docs/screenshots";
// Full-page captures: render the sticky sidebar at the top instead of mid-page.
const SHOT_CSS = "aside { position: static !important; }";

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}

// The optional account-verification banner is covered by ux.spec.ts; skip it here so the
// screenshots show each page's own content.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sentinel.identity", JSON.stringify({ skipped: true })));
});

test("overview shows live provider status with source and freshness", async ({ page }) => {
  const errors = trackConsole(page);
  await page.goto("/#/overview");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const reachable = page.locator("text=Providers reachable").locator("..");
  await expect(reachable).toContainText(/\d+ \/ \d+/);
  await expect(reachable).toContainText(/Source: background prober · updated/);
  await expect(page.getByText("Live updates:")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/overview.png`, fullPage: true, style: SHOT_CSS });
  expect(errors).toEqual([]);
});

test("providers page: tested capability matrix shows dRPC without tx_status", async ({ page }) => {
  const errors = trackConsole(page);
  await page.goto("/#/providers");
  const row = page.locator("tr", { hasText: "near-testnet.drpc.org" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("up");
  // columns: archival, tx, tx_status, EXPERIMENTAL_tx_status
  const cells = row.locator("td");
  await expect(cells.nth(6)).toContainText("no"); // tx_status
  await expect(cells.nth(7)).toContainText("yes"); // EXPERIMENTAL_tx_status
  const archival = page.locator("tr", { hasText: "archival-rpc.testnet.fastnear.com" }).locator("td").nth(4);
  await expect(archival).toContainText("yes");
  await expect(page.getByRole("img", { name: /Latency over time/ }).or(page.getByText("Not enough samples yet"))).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/providers.png`, fullPage: true, style: SHOT_CSS });
  expect(errors).toEqual([]);
});

test("inspect: real partially-completed testnet tx → MANUAL_REVIEW_REQUIRED with failing receipts visible", async ({ page }) => {
  const errors = trackConsole(page);
  await page.goto("/#/inspect");
  await page.getByRole("button", { name: "Partially completed" }).click();
  await expect(page.getByText("Manual review required")).toBeVisible();
  await expect(page.getByText("PARTIALLY_COMPLETED").first()).toBeVisible();
  await expect(page.getByText(/agreement: (UNANIMOUS|CONSISTENT_WITH_LAG)/)).toBeVisible();
  // receipt graph: root succeeded, ft_burn failed, auto-expanded path to the failure
  await expect(page.getByText("run_buyback()", { exact: true })).toBeVisible();
  await expect(page.getByText("ft_burn()", { exact: true })).toBeVisible(); // the receipt-graph chip
  await expect(page.getByText(/✕ .*unreachable/).first()).toBeVisible();
  // diagnostics with evidence
  await expect(page.getByText("RECEIPT_EXECUTION_FAILURE").first()).toBeVisible();
  await page.getByRole("button", { name: /Show the \d+ checks? behind/ }).click();
  await expect(page.getByText("tx-found-by-any-provider")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/inspect-partial.png`, fullPage: true, style: SHOT_CSS });
  expect(errors).toEqual([]);
});

test("inspect: real successful tx → DO_NOT_RETRY; receipt graph expands and exports", async ({ page }) => {
  const errors = trackConsole(page);
  await page.goto("/#/inspect");
  await page.getByRole("button", { name: "Succeeded" }).click();
  await expect(page.getByText("Do not retry", { exact: true })).toBeVisible();
  await expect(page.getByText("EXECUTED_SUCCESS").first()).toBeVisible();
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByText("refund").first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export graph (JSON)" }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^receipt-graph-9WeBPyuE9vC6.*\.json$/);
  await page.screenshot({ path: `${SHOTS}/inspect-success.png`, fullPage: true, style: SHOT_CSS });
  expect(errors).toEqual([]);
});

test("inspect: invalid input shows the API error with request id", async ({ page }) => {
  await page.goto("/#/inspect");
  await page.getByLabel("Transaction hash").fill("not-a-hash");
  await page.getByLabel("Sender account").fill("alice.testnet");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("INVALID_INPUT");
  await expect(page.getByRole("alert")).toContainText("request id:");
});

test("unknown tx → WAIT_AND_RECHECK (absence is not proof)", async ({ page }) => {
  await page.goto("/#/inspect");
  await page.getByLabel("Transaction hash").fill("11111111111111111111111111111112");
  await page.getByLabel("Sender account").fill("alice.testnet");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByText("Wait and re-check")).toBeVisible();
  await expect(page.getByText(/Absence is not proof/)).toBeVisible();
});

test("incidents, benchmarks, integrate and settings pages render without errors", async ({ page }) => {
  const errors = trackConsole(page);
  for (const [route, heading, shot] of [
    ["incidents", "Incidents", "incidents"],
    ["benchmarks", "Benchmarks", "benchmarks"],
    ["integrate", "Integrate (SDK · MCP · API)", "integrate"],
    ["settings", "Settings", "settings"],
  ] as const) {
    await page.goto(`/#/${route}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(page.getByRole("status")).toHaveCount(0, { timeout: 30_000 }); // no lingering spinners
    await page.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: true, style: SHOT_CSS });
  }
  await expect(page.getByText("Real-world measurements").or(page.getByText("Configuration (read-only)"))).toBeVisible();
  expect(errors).toEqual([]);
});
