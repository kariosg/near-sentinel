import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SentinelUrlRejectedError } from "../src/errors.js";
import { assertPublicRpcUrl, createGuardedFetch, isPublicAddress } from "../src/ssrf.js";
import { startMockRpc, type RunningServer } from "../src/testing.js";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "::",
  ])("blocks %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));

  it("rejects non-IPs", () => expect(isPublicAddress("example.com")).toBe(false));
});

describe("assertPublicRpcUrl (no DNS needed for these cases)", () => {
  it.each([
    ["http://1.1.1.1", /Protocol/],
    ["https://127.0.0.1", /not a public/],
    ["https://[::1]", /not a public/],
    ["https://[::ffff:127.0.0.1]", /not a public/],
    ["https://169.254.169.254/latest/meta-data", /not a public/],
    ["https://localhost", /Internal hostnames/],
    ["https://api.localhost", /Internal hostnames/],
    ["https://metadata.google.internal", /Internal hostnames/],
    ["https://user:pass@1.1.1.1", /Credentials/],
    ["https://1.1.1.1:22", /Port 22/],
    ["ftp://1.1.1.1", /Protocol/],
    ["file:///etc/passwd", /Protocol/],
    ["not a url", /valid URL/],
  ])("rejects %s", async (url, msg) => {
    await expect(assertPublicRpcUrl(url)).rejects.toThrow(msg);
    await expect(assertPublicRpcUrl(url)).rejects.toBeInstanceOf(SentinelUrlRejectedError);
  });

  it("WHATWG URL normalises decimal/hex IPs to dotted form, which is then blocked", async () => {
    // new URL("https://2130706433").hostname === "127.0.0.1"
    await expect(assertPublicRpcUrl("https://2130706433")).rejects.toThrow(/not a public/);
    await expect(assertPublicRpcUrl("https://0x7f.0.0.1")).rejects.toThrow(/not a public/);
  });

  it("accepts a public IP literal over https", async () => {
    await expect(assertPublicRpcUrl("https://1.1.1.1")).resolves.toBeInstanceOf(URL);
  });

  it("allowPrivateNetworks (local dev) permits loopback on any port, but still rejects credentials and bad protocols", async () => {
    const dev = { allowPrivateNetworks: true, allowHttp: true };
    await expect(assertPublicRpcUrl("http://127.0.0.1:59850", dev)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicRpcUrl("http://u:p@127.0.0.1:59850", dev)).rejects.toThrow(/Credentials/);
    await expect(assertPublicRpcUrl("file:///etc/passwd", dev)).rejects.toThrow(/Protocol/);
    // Without the opt-in, the same URL is rejected.
    await expect(assertPublicRpcUrl("http://127.0.0.1:59850", { allowHttp: true })).rejects.toThrow();
  });

  it("allowHttp opt-in permits http", async () => {
    await expect(assertPublicRpcUrl("http://1.1.1.1", { allowHttp: true })).resolves.toBeInstanceOf(URL);
  });
});

describe("createGuardedFetch blocks private targets at connection time", () => {
  let mock: RunningServer;
  beforeAll(async () => {
    mock = await startMockRpc(() => ({ result: "should never be reached" }));
  });
  afterAll(() => mock.close());

  it("IP literal loopback is refused before connecting", async () => {
    const f = createGuardedFetch();
    await expect(f(mock.url, { method: "POST", body: "{}" })).rejects.toThrow(/non-public/);
    expect(mock.requests).toHaveLength(0);
  });

  it("a hostname resolving to loopback ('localhost') is refused by the connect-time lookup", async () => {
    const f = createGuardedFetch();
    const url = mock.url.replace("127.0.0.1", "localhost");
    const err: any = await f(url, { method: "POST", body: "{}" }).then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    // undici wraps connect errors as "fetch failed" with the real reason in `cause`.
    expect(String(err.cause?.message ?? err.message)).toMatch(/Blocked connection to non-public address/);
    expect(mock.requests).toHaveLength(0);
  });

  it("allowPrivateNetworks (dev only) does connect", async () => {
    const f = createGuardedFetch({ allowPrivateNetworks: true });
    const res = await f(mock.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }) });
    expect(res.status).toBe(200);
  });
});
