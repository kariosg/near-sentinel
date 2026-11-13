import { afterEach, describe, expect, it } from "vitest";
import { NearSentinel } from "../src/sentinel.js";
import { SentinelInputError } from "../src/errors.js";
import { accountKind, decideReceiver, lookalikeOf, NO_CONTRACT_CODE_HASH, type ReceiverProviderObservation } from "../src/receiver.js";
import { startMockRpc, type MockAnswer, type RunningServer } from "../src/testing.js";
import type { ProviderConfig } from "../src/types.js";

const KNOWN = "karios.testnet";
const account = (height = 5000, code_hash = NO_CONTRACT_CODE_HASH): MockAnswer => ({
  result: { amount: "1000000000000000000000000", locked: "0", code_hash, storage_usage: 182, storage_paid_at: 0, block_height: height, block_hash: "x" },
});
const legacyMissing = (id: string, height = 5001): MockAnswer => ({ result: { error: `account ${id} does not exist while viewing`, logs: [], block_height: height, block_hash: "x" } });
const structuredMissing = (id: string): MockAnswer => ({
  error: { name: "HANDLER_ERROR", code: -32000, message: "Server error", data: `account ${id} does not exist while viewing`, cause: { name: "UNKNOWN_ACCOUNT", info: {} } },
});

const servers: RunningServer[] = [];
const seen: any[] = [];
async function provider(name: string, answer: MockAnswer): Promise<ProviderConfig> {
  const srv = await startMockRpc((method, params) => {
    seen.push({ name, method, params });
    return answer;
  });
  servers.push(srv);
  return { name, url: srv.url, operator: name };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  seen.length = 0;
});
const S = (p: ProviderConfig[]) => new NearSentinel({ rpcProviders: p, timeoutMs: 1500 });

const H64 = "a1b2" + "0".repeat(56) + "c3d4";
const E40 = "0xa1b2" + "0".repeat(32) + "c3d4";

describe("lookalikeOf (pure)", () => {
  const positives: Array<[string, string[], string, string]> = [
    ["kari0s.testnet", [KNOWN], KNOWN, "homoglyph"],
    ["kar1os.testnet", ["karlos.testnet"], "karlos.testnet", "homoglyph"],
    ["5h0p-pay.testnet", ["shop-pay.testnet"], "shop-pay.testnet", "homoglyph"],
    ["rnoney.testnet", ["money.testnet"], "money.testnet", "homoglyph"],
    ["vvallet.testnet", ["wallet.testnet"], "wallet.testnet", "homoglyph"],
    ["kar-ios.testnet", [KNOWN], KNOWN, "hyphenation"],
    ["kari_os.testnet", [KNOWN], KNOWN, "hyphenation"],
    ["myshop.testnet", ["my-shop.testnet"], "my-shop.testnet", "hyphenation"],
    ["kairos.testnet", [KNOWN], KNOWN, "transposition"],
    ["karos.testnet", [KNOWN], KNOWN, "omission"],
    ["kariosx.testnet", [KNOWN], KNOWN, "insertion"],
    ["karioss.testnet", [KNOWN], KNOWN, "insertion"],
    ["kerios.testnet", [KNOWN], KNOWN, "vowel-swap"],
    ["karies.testnet", [KNOWN], KNOWN, "vowel-swap"],
    ["kabios.testnet", [KNOWN], KNOWN, "replacement"],
    ["karios-testnet.testnet", [KNOWN], KNOWN, "subdomain"],
    ["karios.testnet.evil.testnet", [KNOWN], KNOWN, "subdomain"],
    ["pay-karios.testnet", [KNOWN], KNOWN, "subdomain"],
    ["karios.evil.testnet", [KNOWN], KNOWN, "subdomain"],
    ["kari0s-pay.testnet", [KNOWN], KNOWN, "subdomain"],
    ["vault-karios.testnet", ["vault.karios.testnet"], "vault.karios.testnet", "hyphenation"],
    ["vault-karios.evil.testnet", ["vault.karios.testnet"], "vault.karios.testnet", "subdomain"],
    [H64.slice(0, 10) + "f" + H64.slice(11), [H64], H64, "address-poisoning"],
    [E40.slice(0, 12) + "f" + E40.slice(13), [E40], E40, "address-poisoning"],
    // the first matching known receiver is reported
    ["kari0s.testnet", ["bob.testnet", "shop.testnet", KNOWN], KNOWN, "homoglyph"],
  ];
  it.each(positives)("%s imitates %s", (r, known, of, technique) => {
    expect(lookalikeOf(r, known)).toEqual({ of, technique });
  });

  const negatives: Array<[string, string, string[]]> = [
    ["exact match", KNOWN, [KNOWN]],
    ["exact match among others", KNOWN, ["kari0s.testnet", KNOWN]],
    ["short known name, one edit", "bab.testnet", ["bob.testnet"]],
    ["same name on the other network", "karios.near", [KNOWN]],
    ["same sub-account on the other network", "shop.karios.near", ["shop.karios.testnet"]],
    ["unrelated name", "alice.testnet", [KNOWN]],
    ["two edits", "kbrioz.testnet", [KNOWN]],
    ["real sub-account of the known account", "shop.karios.testnet", [KNOWN]],
    ["no known receivers", "kari0s.testnet", []],
    ["token inside a longer word is not a token", "kariosity.testnet", [KNOWN]],
    ["implicit vs named known", H64, [KNOWN]],
    ["named vs implicit known", "kari0s.testnet", [H64]],
    ["different start", "ffff" + H64.slice(4), [H64]],
    ["different end", H64.slice(0, 60) + "ffff", [H64]],
    ["near-implicit vs eth-implicit", H64, [E40]],
  ];
  it.each(negatives)("not a lookalike: %s", (_n, r, known) => {
    expect(lookalikeOf(r, known)).toBeNull();
  });
});

describe("lookalikeOf regression table (review findings)", () => {
  const cases: Array<[string, string, string, string | null]> = [
    // short first labels no longer hide homoglyphs, hyphenation or subdomains; one-edit compares the full core
    ["multi-label homoglyph", "pay.kari0s.testnet", "pay.karios.testnet", "homoglyph"],
    ["multi-label subdomain", "pay.karios.testnet.evil.testnet", "pay.karios.testnet", "subdomain"],
    ["multi-label one edit (full core)", "v2.ref-flnance.near", "v2.ref-finance.near", "replacement"],
    ["short name homoglyph", "b0b.testnet", "bob.testnet", "homoglyph"],
    ["short name homoglyph on mainnet", "b0b.near", "bob.near", "homoglyph"],
    ["short name hyphenation", "b-ob.testnet", "bob.testnet", "hyphenation"],
    // homoglyph plus one more edit
    ["homoglyph + insertion", "kari0ss.testnet", "karios.testnet", "homoglyph"],
    ["homoglyph + replacement", "karl0s.testnet", "karios.testnet", "homoglyph"],
    ["two homoglyphs + insertion", "k4rios1.testnet", "karios.testnet", "homoglyph"],
    ["homoglyph + edit on a multi-label core", "pay.kari0ss.testnet", "pay.karios.testnet", "homoglyph"],
    ["homoglyph + two edits stays quiet", "kbri0sxx.testnet", "karios.testnet", null],
    // the extra-words rule needs a core of at least 4 characters and a named (dotted) known account
    ["short core: ref", "ref-finance.near", "ref.near", null],
    ["short core: jo", "jo-pizza.near", "jo.near", null],
    ["short core: bob", "bob-shop.testnet", "bob.testnet", null],
    ["short core: bob-pay", "bob-pay.testnet", "bob.testnet", null],
    ["top-level known reused as a label", "aurora.pool.near", "aurora", null],
    ["4-character core still gets the rule", "pay-shop.testnet", "shop.testnet", "subdomain"],
    ["short name one edit stays quiet", "bab.testnet", "bob.testnet", null],
    // cores compared across networks
    ["homoglyph on the other network", "kari0s.near", "karios.testnet", "homoglyph"],
    ["one edit on the other network", "kairos.near", "karios.testnet", "transposition"],
    ["network suffix dropped", "karios", "karios.testnet", "omission"],
    ["network suffix added to a top-level name", "karios.testnet", "karios", "insertion"],
    ["dots removed", "kariostestnet", "karios.testnet", "hyphenation"],
    // must stay null
    ["real sub-account", "shop.karios.testnet", "karios.testnet", null],
    ["same name on the other network", "karios.near", "karios.testnet", null],
    ["longer word", "karioscorp.testnet", "karios.testnet", null],
    ["implicit vs named", H64, "karios.testnet", null],
    ["named vs implicit", "karios.testnet", H64, null],
    ["non-network last label is part of the core", "token.v2.ref-finance.near", "token.sweat", null],
  ];
  it.each(cases)("%s: %s vs %s", (_n, r, known, technique) => {
    expect(lookalikeOf(r, [known])).toEqual(technique ? { of: known, technique } : null);
  });

  it.each([
    ["sibling of a known sub-account", "pay2.karios.testnet"],
    ["deeper sub-account", "a.pay.karios.testnet"],
    ["homoglyph-looking sub-account of a known parent", "pay.kari0s.karios.testnet"],
  ])("sub-accounts of any known account are never lookalikes: %s", (_n, r) => {
    expect(lookalikeOf(r, ["karios.testnet", "pay.karios.testnet"])).toBeNull();
  });
  it("without the parent in the list, the sibling is still checked", () => {
    expect(lookalikeOf("pay2.karios.testnet", ["pay.karios.testnet"])).toEqual({ of: "pay.karios.testnet", technique: "insertion" });
  });
});

describe("accountKind (pure)", () => {
  it.each([
    [KNOWN, "named"],
    ["vault.karios.testnet", "named"],
    [H64, "near-implicit"],
    [E40, "eth-implicit"],
    ["near", "top-level"],
    ["0xabc", "top-level"],
    ["a".repeat(63), "top-level"],
  ])("%s is %s", (id, kind) => expect(accountKind(id)).toBe(kind));
});

describe("decideReceiver (pure)", () => {
  const ex = (provider: string, blockHeight: number, codeHash = NO_CONTRACT_CODE_HASH): ReceiverProviderObservation => ({ provider, operator: provider, answer: "EXISTS", blockHeight, codeHash, latencyMs: 1 });
  const nf = (provider: string, blockHeight: number): ReceiverProviderObservation => ({ provider, operator: provider, answer: "NOT_FOUND", blockHeight, latencyMs: 1 });
  const err = (provider: string): ReceiverProviderObservation => ({ provider, operator: provider, answer: "ERROR", error: "x", latencyMs: 1 });

  it("lookalike is DANGER even when no provider answered (it needs no network)", () => {
    const r = decideReceiver({ receiverId: "kari0s.testnet", knownReceivers: [KNOWN] }, [err("a")]);
    expect(r).toMatchObject({ status: "DANGER", lookalikeOf: KNOWN, knownReceiver: false });
    expect(r.exists).toBeUndefined();
    expect(r.findings[0]).toMatchObject({ severity: "high", technique: "homoglyph" });
    expect(r.findings[0]!.detail).toContain(KNOWN);
  });
  it("named accounts: any reachable NOT_FOUND wins (worst case), with the disagreement finding", () => {
    const cases: ReceiverProviderObservation[][] = [
      [nf("a", 10), ex("b", 11)],
      [ex("a", 11), nf("b", 12)],
      [ex("a", 11), nf("b", 11)],
      // structured UNKNOWN_ACCOUNT errors carry no block height: a higher EXISTS must not hide them
      [{ ...nf("a", 0), blockHeight: undefined }, { ...nf("b", 0), blockHeight: undefined }, ex("c", 100)],
    ];
    for (const obs of cases) {
      const r = decideReceiver({ receiverId: "new.testnet" }, obs);
      expect(r).toMatchObject({ status: "NOT_FOUND", exists: false });
      expect(r.findings.map((f) => f.title)).toContain("Providers disagree on whether the account exists");
      expect(r.reason).toMatch(/worst case/);
    }
    expect(decideReceiver({ receiverId: "near" }, [ex("a", 100), nf("b", 1)]).status).toBe("NOT_FOUND"); // top-level too
  });
  it("implicit accounts: freshest answer wins on a split (not existing yet is normal)", () => {
    expect(decideReceiver({ receiverId: H64, knownReceivers: [H64] }, [nf("a", 10), ex("b", 11)])).toMatchObject({ status: "WARNING", exists: true });
    expect(decideReceiver({ receiverId: H64, knownReceivers: [H64] }, [ex("a", 10), nf("b", 11)])).toMatchObject({ status: "WARNING", exists: false });
  });
  it("a known implicit address that does not exist yet is OK", () => {
    const r = decideReceiver({ receiverId: H64, knownReceivers: [H64] }, [nf("a", 10)]);
    expect(r).toMatchObject({ status: "OK", exists: false, knownReceiver: true, kind: "near-implicit" });
    expect(r.reason).toMatch(/not created yet/);
  });
  it("a top-level account gets an info finding only", () => {
    const r = decideReceiver({ receiverId: "near" }, [ex("a", 10)]);
    expect(r.status).toBe("OK");
    expect(r.findings).toEqual([expect.objectContaining({ severity: "info", title: "Top-level account" })]);
  });
  it("drops the code hash from the provider evidence", () => {
    expect(decideReceiver({ receiverId: KNOWN }, [ex("a", 10)]).providers[0]).not.toHaveProperty("codeHash");
  });
});

describe("checkReceiver (view_account on every provider)", () => {
  it("sends view_account at finality=final", async () => {
    await S([await provider("a", account())]).checkReceiver({ receiverId: KNOWN });
    expect(seen.map((x) => [x.method, x.params])).toEqual([["query", { request_type: "view_account", finality: "final", account_id: KNOWN }]]);
  });

  it("OK for a known receiver that exists; knownReceiver true; no new-payee notice", async () => {
    const r = await S([await provider("a", account()), await provider("b", account(5001))]).checkReceiver({ receiverId: KNOWN, knownReceivers: [KNOWN] });
    expect(r).toMatchObject({ receiverId: KNOWN, status: "OK", kind: "named", exists: true, isContract: false, knownReceiver: true, findings: [] });
    expect(r.lookalikeOf).toBeUndefined();
    expect(r.providers).toEqual([
      expect.objectContaining({ provider: "a", operator: "a", answer: "EXISTS", blockHeight: 5000 }),
      expect.objectContaining({ provider: "b", answer: "EXISTS", blockHeight: 5001 }),
    ]);
    expect(typeof r.providers[0]!.latencyMs).toBe("number");
    expect(typeof r.checkedAt).toBe("string");
  });

  it("no knownReceivers: knownReceiver is absent and there is no new-payee notice", async () => {
    const r = await S([await provider("a", account())]).checkReceiver({ receiverId: KNOWN });
    expect(r.status).toBe("OK");
    expect(r).not.toHaveProperty("knownReceiver");
    expect(r.findings).toEqual([]);
  });

  it("DANGER for a homoglyph lookalike that exists; new-payee notice as info", async () => {
    const r = await S([await provider("a", account())]).checkReceiver({ receiverId: "kari0s.testnet", knownReceivers: [KNOWN] });
    expect(r).toMatchObject({ status: "DANGER", lookalikeOf: KNOWN, knownReceiver: false, exists: true });
    expect(r.findings.map((f) => f.severity)).toEqual(["high", "info"]);
    expect(r.findings[1]!.title).toBe("New payee: verify it from the original source, never from transaction history");
    expect(r.reason).toMatch(/Do not pay; ask a human/);
  });

  it("DANGER beats NOT_FOUND", async () => {
    const r = await S([await provider("a", legacyMissing("kairos.testnet"))]).checkReceiver({ receiverId: "kairos.testnet", knownReceivers: [KNOWN] });
    expect(r).toMatchObject({ status: "DANGER", exists: false });
    expect(r.findings.filter((f) => f.severity === "high")).toHaveLength(2);
  });

  it("NOT_FOUND from a legacy result.error string", async () => {
    const id = "no-such-acct.testnet";
    const r = await S([await provider("a", legacyMissing(id))]).checkReceiver({ receiverId: id });
    expect(r).toMatchObject({ status: "NOT_FOUND", exists: false });
    expect(r.providers[0]).toMatchObject({ answer: "NOT_FOUND", blockHeight: 5001 });
    expect(r.reason).toMatch(/does not exist/);
  });

  it("NOT_FOUND from a structured UNKNOWN_ACCOUNT error", async () => {
    const id = "no-such-acct.testnet";
    const r = await S([await provider("a", structuredMissing(id))]).checkReceiver({ receiverId: id });
    expect(r.status).toBe("NOT_FOUND");
    expect(r.providers[0]!.answer).toBe("NOT_FOUND");
  });

  it("contract account: info finding only, status OK", async () => {
    const r = await S([await provider("a", account(5000, "E8jZ1giWcVrps8PcV75ATauu6gFRkcwjNtKp7NKmipZG"))]).checkReceiver({ receiverId: "shop.testnet" });
    expect(r).toMatchObject({ status: "OK", isContract: true });
    expect(r.findings).toEqual([expect.objectContaining({ severity: "info", title: "Contract account" })]);
    expect(r.reason).toMatch(/a contract/);
  });

  it("raw near-implicit address not in the known list: WARNING", async () => {
    const r = await S([await provider("a", account())]).checkReceiver({ receiverId: H64 });
    expect(r).toMatchObject({ status: "WARNING", kind: "near-implicit", exists: true });
    expect(r.findings[0]).toMatchObject({ severity: "medium", title: "Raw address, verify all characters" });
  });

  it("raw eth-implicit address that does not exist yet: info + WARNING, never NOT_FOUND", async () => {
    const r = await S([await provider("a", structuredMissing(E40))]).checkReceiver({ receiverId: E40 });
    expect(r).toMatchObject({ status: "WARNING", kind: "eth-implicit", exists: false });
    expect(r.findings.map((f) => f.title)).toContain("Implicit account not created yet");
  });

  it("address poisoning is DANGER", async () => {
    const poisoned = H64.slice(0, 20) + "9" + H64.slice(21);
    const r = await S([await provider("a", account())]).checkReceiver({ receiverId: poisoned, knownReceivers: [H64] });
    expect(r).toMatchObject({ status: "DANGER", lookalikeOf: H64 });
    expect(r.findings[0]).toMatchObject({ technique: "address-poisoning", title: `Address poisoning: looks like ${H64}` });
  });

  it("a known raw address is OK (no raw-address warning)", async () => {
    const r = await S([await provider("a", account())]).checkReceiver({ receiverId: H64, knownReceivers: [H64] });
    expect(r.status).toBe("OK");
  });

  it("providers disagree on a named account: NOT_FOUND (worst case) with a note", async () => {
    const r = await S([await provider("lagging", legacyMissing("new.testnet", 4000)), await provider("fresh", account(6000))]).checkReceiver({ receiverId: "new.testnet" });
    expect(r).toMatchObject({ status: "NOT_FOUND", exists: false });
    expect(r.findings.map((f) => f.title)).toContain("Providers disagree on whether the account exists");
    expect(r.reason).toMatch(/reporting NOT_FOUND because lagging says the account does not exist \(worst case\)/);
  });

  it("structured UNKNOWN_ACCOUNT (no block height) beats a higher EXISTS: NOT_FOUND", async () => {
    const id = "new.testnet";
    const r = await S([await provider("a", structuredMissing(id)), await provider("b", structuredMissing(id)), await provider("c", account(100))]).checkReceiver({ receiverId: id });
    expect(r.status).toBe("NOT_FOUND");
  });

  it("providers disagree on an implicit address: WARNING, freshest answer", async () => {
    const r = await S([await provider("lagging", structuredMissing(H64)), await provider("fresh", account(6000))]).checkReceiver({ receiverId: H64, knownReceivers: [H64] });
    expect(r).toMatchObject({ status: "WARNING", exists: true });
    expect(r.reason).toMatch(/freshest answer \(fresh, block 6000\)/);
  });

  it("UNKNOWN when no provider answers (502)", async () => {
    const r = await S([await provider("a", { fault: { type: "http-502" } })]).checkReceiver({ receiverId: KNOWN, knownReceivers: [KNOWN] });
    expect(r.status).toBe("UNKNOWN");
    expect(r.exists).toBeUndefined();
    expect(r.providers[0]!.answer).toBe("ERROR");
  });

  it("one provider erroring does not hide the other's answer", async () => {
    const r = await S([await provider("a", { fault: { type: "http-502" } }), await provider("b", account())]).checkReceiver({ receiverId: KNOWN });
    expect(r).toMatchObject({ status: "OK", exists: true });
  });

  it("malformed answers are ERROR, never trusted", async () => {
    const r = await S([await provider("a", { result: { amount: 5, block_height: 1 } })]).checkReceiver({ receiverId: KNOWN });
    expect(r.status).toBe("UNKNOWN");
    expect(r.providers[0]!.error).toMatch(/malformed/);
  });

  it.each([
    ["bad receiver", { receiverId: "Not Valid" }],
    ["bad known receiver", { receiverId: KNOWN, knownReceivers: ["Bad Known"] }],
    ["21 known receivers", { receiverId: KNOWN, knownReceivers: Array.from({ length: 21 }, (_, i) => `known${i}.testnet`) }],
    ["unknown field", { receiverId: KNOWN, evil: 1 }],
  ])("rejects %s before any network call", async (_n, input) => {
    await expect(S([await provider("a", account())]).checkReceiver(input as any)).rejects.toBeInstanceOf(SentinelInputError);
    expect(seen).toHaveLength(0);
  });

  it("accepts exactly 20 known receivers", async () => {
    const r = await S([await provider("a", account())]).checkReceiver({ receiverId: KNOWN, knownReceivers: Array.from({ length: 20 }, (_, i) => `known${i}.testnet`) });
    expect(r.knownReceiver).toBe(false);
  });
});
