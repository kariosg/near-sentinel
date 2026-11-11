import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDERS } from "../src/networks.js";

describe("default providers", () => {
  for (const net of ["testnet", "mainnet"] as const) {
    it(`${net}: at least 3 independent operators, and no FastNEAR alias counted as another operator`, () => {
      const ps = DEFAULT_PROVIDERS[net];
      expect(new Set(ps.map((p) => p.operator)).size).toBeGreaterThanOrEqual(3);
      // rpc.*.near.org is a CNAME to external-dns.fastnear.com (checked 2026-11-11); it must never be a separate witness.
      for (const p of ps) {
        const host = new URL(p.url).hostname;
        if (host.endsWith("near.org") || host.endsWith("fastnear.com")) expect(p.operator).toBe("fastnear");
      }
      expect(ps.every((p) => p.url.startsWith("https://"))).toBe(true);
    });
  }
});
