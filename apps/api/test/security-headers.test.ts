import { describe, expect, it } from "vitest";
import { CSP_ENFORCED, CSP_REPORT_ONLY, securityHeaders } from "../src/security-headers.js";

describe("securityHeaders", () => {
  it("enforces only non-breaking CSP directives and reports the strict policy", () => {
    const h = securityHeaders({ url: "/", https: false });
    expect(h["content-security-policy"]).toBe(CSP_ENFORCED);
    for (const d of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) expect(h["content-security-policy"]).toContain(d);
    expect(h["content-security-policy"]).not.toMatch(/script-src|connect-src|default-src/);
    expect(h["content-security-policy-report-only"]).toBe(CSP_REPORT_ONLY);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    expect(h).not.toHaveProperty("cross-origin-embedder-policy");
  });
  it("adds upgrade-insecure-requests only over HTTPS", () => {
    expect(securityHeaders({ url: "/", https: true })["content-security-policy"]).toContain("upgrade-insecure-requests");
    expect(securityHeaders({ url: "/", https: false })["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });
  it("API responses are same-origin resources; pages are same-site", () => {
    expect(securityHeaders({ url: "/api/v1/health", https: false })["cross-origin-resource-policy"]).toBe("same-origin");
    expect(securityHeaders({ url: "/assets/x.js", https: false })["cross-origin-resource-policy"]).toBe("same-site");
  });
  it("Swagger UI (/docs) gets the enforced policy but not the report-only one", () => {
    expect(securityHeaders({ url: "/docs", https: false })).not.toHaveProperty("content-security-policy-report-only");
    expect(securityHeaders({ url: "/docs/static/index.html", https: false })).not.toHaveProperty("content-security-policy-report-only");
    expect(securityHeaders({ url: "/documents", https: false })).toHaveProperty("content-security-policy-report-only");
  });
});
