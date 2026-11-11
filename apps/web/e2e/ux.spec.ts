/**
 * UI/UX quality gates against the real API + NEAR testnet (read-only):
 *  - accessibility (axe: no serious/critical violations) on every page
 *  - responsive layout (mobile, tablet, desktop): no horizontal overflow, no console errors
 *  - keyboard navigation with visible focus
 *  - the OPTIONAL account verification: skippable, persists, wallet URL, cancel and forged callbacks
 *  - the guard-contract lookup panel
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SHOTS = "../../docs/screenshots";
// Full-page captures: render the sticky sidebar at the top instead of mid-page.
const SHOT_CSS = "aside { position: static !important; }";
const PAGES = ["start", "overview", "inspect", "providers", "incidents", "benchmarks", "integrate", "settings"];
const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1360, height: 900 },
];

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    // 400s from deliberately invalid identity callbacks are asserted explicitly in those tests.
    if (r.status() >= 400 && !r.url().includes("/api/v1/identity/")) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}

const skipIdentity = (page: Page) => page.addInitScript(() => localStorage.setItem("sentinel.identity", JSON.stringify({ skipped: true })));

test.describe("accessibility", () => {
  for (const p of PAGES) {
    test(`${p}: no serious or critical axe violations`, async ({ page }) => {
      await skipIdentity(page);
      await page.goto(`/#/${p}`);
      await expect(page.locator("main h1")).toBeVisible();
      await page.waitForLoadState("networkidle");
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
    });
  }
});

test.describe("responsive layout", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} ${vp.width}px: every page fits without horizontal scrolling`, async ({ page }) => {
      const errors = trackErrors(page);
      await skipIdentity(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const p of PAGES) {
        await page.goto(`/#/${p}`);
        await expect(page.locator("main h1")).toBeVisible();
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${p} overflows by ${overflow}px at ${vp.width}px`).toBeLessThanOrEqual(1);
      }
      if (vp.name === "mobile") {
        await page.goto("/#/overview");
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: `${SHOTS}/mobile-overview.png`, fullPage: true, style: SHOT_CSS });
      }
      expect(errors).toEqual([]);
    });
  }
});

test("keyboard: Tab reaches the navigation with a visible focus indicator, Enter navigates", async ({ page }) => {
  await skipIdentity(page);
  await page.goto("/#/overview");
  await expect(page.locator("main h1")).toHaveText("Overview");
  let found = false;
  for (let i = 0; i < 15 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => document.activeElement?.textContent?.trim() === "RPC providers");
  }
  expect(found).toBe(true);
  const outline = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement as Element);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), shadow: cs.boxShadow };
  });
  expect(outline.style !== "none" && outline.width > 0 || outline.shadow !== "none").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("main h1")).toHaveText("RPC providers");
});

test.describe("optional account verification", () => {
  test("banner explains it is optional (note for judges); Skip hides it and persists", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/#/overview");
    const banner = page.getByRole("region", { name: /Verify your NEAR account/ });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Note for judges");
    await expect(banner).toContainText("optional");
    await page.screenshot({ path: `${SHOTS}/identity-optional.png` });
    await banner.getByRole("button", { name: /Skip/ }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("region", { name: /Verify your NEAR account/ })).toBeHidden();
    await expect(page.getByText("not verified (optional)")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Verify sends the user to MyNearWallet with a server nonce, the message and our callback", async ({ page, baseURL }) => {
    let walletUrl = "";
    await page.route("https://testnet.mynearwallet.com/**", (route) => {
      walletUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: "text/html", body: "<title>wallet stub</title>" });
    });
    await page.goto("/#/overview");
    await page.getByRole("button", { name: /Verify with MyNearWallet/ }).click();
    await expect.poll(() => walletUrl).toContain("/sign-message?");
    const q = new URL(walletUrl).searchParams;
    expect(Buffer.from(q.get("nonce")!, "base64")).toHaveLength(32);
    expect(q.get("recipient")).toBe("near-sentinel");
    expect(q.get("message")).toMatch(/cannot move funds/);
    // The wallet must send the user back to this same site (local or deployed).
    expect(q.get("callbackUrl")).toBe(`${new URL(baseURL!).origin}/`);
  });

  test("a cancelled wallet flow shows a calm message and the app keeps working", async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto("/#error=User%20rejected");
    await expect(page.getByRole("alert")).toContainText(/cancelled or failed.*optional/);
    await expect(page.locator("main h1")).toHaveText("Overview");
    expect(page.url()).toMatch(/#\/overview$/);
    expect(errors).toEqual([]);
  });

  test("a forged wallet callback is rejected by the server and nothing is marked verified", async ({ page }) => {
    await page.goto("/#/overview");
    // Start a real challenge so the tab has a pending nonce, but stop at the wallet.
    await page.route("https://testnet.mynearwallet.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "stub" }));
    await page.getByRole("button", { name: /Verify with MyNearWallet/ }).click();
    await page.waitForURL(/mynearwallet/);
    const forged = Buffer.alloc(64, 1).toString("base64");
    // A public key that is well-formed base58 but not 32 bytes must be a clean 400, never a 500.
    const verify = page.waitForResponse((r) => r.url().includes("/api/v1/identity/verify"));
    await page.goto(`/#accountId=alice.testnet&publicKey=ed25519%3A${"1".repeat(43)}&signature=${encodeURIComponent(forged)}`);
    expect((await verify).status()).toBe(400);
    await expect(page.getByRole("alert")).toContainText(/Invalid public key|does not verify|not a FullAccess|Challenge/);
    await expect(page.getByText("verified", { exact: true })).toHaveCount(0);
  });
});

test("guard contract panel: unknown contract → UNKNOWN with per-provider evidence, no crash", async ({ page }) => {
  const errors = trackErrors(page);
  await skipIdentity(page);
  await page.goto("/#/inspect");
  await page.getByLabel("Guard contract").fill("sentinel-guard-does-not-exist-e2e.testnet");
  await page.getByLabel("Payer account").fill("alice.testnet");
  await page.getByLabel("Intent ID").fill("order-1");
  await page.getByRole("button", { name: "Check intent" }).click();
  const panel = page.locator("section", { hasText: "Guard contract —" });
  await expect(panel).toContainText("UNKNOWN", { timeout: 30_000 });
  await expect(panel.locator("tbody tr")).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("guard contract panel: live testnet deployment → paid intent is PAID, unused intent is NOT_RECORDED", async ({ page }) => {
  const errors = trackErrors(page);
  await skipIdentity(page);
  await page.goto("/#/inspect");
  const panel = page.locator("section", { hasText: "Guard contract —" });
  await page.getByRole("button", { name: "Paid intent" }).click();
  await expect(panel).toContainText("Already paid: 0.01 NEAR to kariosr.testnet", { timeout: 30_000 });
  // Public RPCs can blip; the verdict needs evidence, not unanimity: at least 2 providers must confirm the record.
  await expect.poll(() => panel.locator("tbody tr", { hasText: "RECORDED" }).count()).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Unused intent" }).click();
  await expect.poll(() => panel.locator("tbody tr", { hasText: "NOT_RECORDED" }).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test("vault panel: live testnet allowance → ACTIVE with limits and the amount available now", async ({ page }) => {
  const errors = trackErrors(page);
  await skipIdentity(page);
  await page.goto("/#/inspect");
  const panel = page.locator("section", { hasText: "Agent allowance —" });
  await page.getByRole("button", { name: "Live agent allowance" }).click();
  await expect(panel).toContainText("ACTIVE", { timeout: 30_000 });
  await expect(panel).toContainText("Available now");
  await expect(panel).toContainText("karios.testnet");
  await expect.poll(() => panel.locator("tbody tr", { hasText: "POLICY" }).count()).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test("vault owner actions: preview shows exactly what the wallet will sign (no wallet opened)", async ({ page }) => {
  const errors = trackErrors(page);
  await skipIdentity(page);
  await page.goto("/#/inspect");
  const owner = page.locator("section", { hasText: "Owner actions (your wallet signs)" }).last();
  await expect(owner.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await owner.getByLabel("Agent to manage").fill("agent.example.testnet");
  await owner.getByLabel("Allowed receivers (comma-separated, empty = any)").fill("shop.testnet, cafe.testnet");
  await owner.getByLabel("Deposit to add (NEAR)").fill("1.5");
  await owner.getByRole("button", { name: "Preview transaction" }).click();
  const preview = owner.locator("pre");
  await expect(preview).toContainText("vault.karios.testnet.set_policy(");
  await expect(preview).toContainText('"agent_id":"agent.example.testnet"');
  await expect(preview).toContainText('"allowed_receivers":["shop.testnet","cafe.testnet"]');
  await expect(preview).toContainText('"per_payment_max":"50000000000000000000000"');
  await expect(preview).toContainText("with deposit 1.5 NEAR (1500000000000000000000000 yoctoNEAR)");
  // Signing needs a connected wallet: the button is disabled until then.
  await expect(owner.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
  await owner.getByRole("tab", { name: "Withdraw" }).click();
  await owner.getByLabel("Agent to manage").fill("agent.example.testnet");
  await owner.getByLabel("Amount to withdraw (NEAR)").fill("abc");
  await owner.getByRole("button", { name: "Preview transaction" }).click();
  await expect(owner).toContainText("is not a NEAR amount");
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  expect(errors).toEqual([]);
});

test("start page: 'Run it live' shows the naive agent paying twice and the guarded agent once", async ({ page }) => {
  const errors = trackErrors(page);
  await skipIdentity(page);
  await page.goto("/#/start");
  await page.getByRole("button", { name: /Run it live/ }).click();
  await expect(page.getByText(/2 transfers · merchant got 2 NEAR/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/1 transfer · merchant got 1 NEAR/)).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("redesign: judge-first navigation", () => {
  test("start page: hero, tour progress, verdict guide; tour step runs the real example", async ({ page }) => {
    const errors = trackErrors(page);
    await skipIdentity(page);
    await page.goto("/");
    await expect(page.locator("main h1")).toContainText("Never pay twice");
    await expect(page.getByRole("img", { name: /Diagram: an AI agent asks NEAR Sentinel/ })).toBeVisible();
    await expect(page.getByText("0 of 5 done")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Four verdicts, never a guess" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/start.png`, fullPage: true, style: SHOT_CSS });
    await page.getByRole("link", { name: /Run it: Inspect a real testnet transaction/ }).click();
    await expect(page.locator("main h1")).toHaveText("Inspect & retry check");
    await expect(page.getByText("Manual review required")).toBeVisible({ timeout: 30_000 });
    await page.goto("/#/start");
    await expect(page.getByText("1 of 5 done")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("command palette: Ctrl+K opens, filters, Enter navigates, Esc closes", async ({ page }) => {
    await skipIdentity(page);
    await page.goto("/#/overview");
    await expect(page.locator("main h1")).toHaveText("Overview");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await page.keyboard.type("provid");
    await page.keyboard.press("Enter");
    await expect(page.locator("main h1")).toHaveText("RPC providers");
    await expect(dialog).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("mobile: menu drawer opens, navigates and closes", async ({ page }) => {
    await skipIdentity(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/start");
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Menu" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Benchmarks" }).click();
    await expect(page.locator("main h1")).toHaveText("Benchmarks");
    await expect(drawer).toBeHidden();
  });

  test("benchmark: one click from the tour runs 12/12 fault scenarios without an API key", async ({ page }) => {
    const errors = trackErrors(page);
    await skipIdentity(page);
    await page.goto("/#/benchmarks?run=simulated");
    await expect(page.getByText(/12 \/ 12 scenarios produced the expected classification/)).toBeVisible({ timeout: 60_000 });
    expect(errors).toEqual([]);
  });
});

test("dialogs are modal for keyboard users: Tab stays inside, focus returns to the opener", async ({ page }) => {
  await skipIdentity(page);
  await page.goto("/#/overview");
  await expect(page.locator("main h1")).toHaveText("Overview");
  const opener = page.getByRole("button", { name: /Search…/ });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog.getByRole("textbox")).toBeFocused();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("reduced motion: the start page shows final values immediately and still works", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await skipIdentity(page);
  await page.goto("/#/start");
  await expect(page.locator("main h1")).toContainText("Never pay twice");
  // Count-ups render their final value without animating (2 NEAR / 1 NEAR in the comparison).
  await expect(page.getByText("2 NEAR", { exact: true })).toBeVisible();
  await expect(page.getByText("1 NEAR", { exact: true })).toBeVisible();
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector(".stagger > *")!).animationDuration);
  expect(parseFloat(anim)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
  await ctx.close();
});
