/**
 * Security headers, defined once (the Caddy reverse proxy sets the same strings, see deploy/vultr/Caddyfile).
 *
 * CSP is rolled out in stages (OWASP CSP Cheat Sheet): the ENFORCED policy only contains directives that cannot
 * break scripts, styles, network calls or the wallet connector's sandboxed iframes; the strict target policy is
 * sent as Content-Security-Policy-Report-Only until owner wallet signing has been re-tested under it. The wallet
 * connector runs wallet code in `srcdoc` iframes, which inherit the page's CSP, so a strict enforced script-src or
 * connect-src would block wallets.
 *
 * Cross-Origin-Embedder-Policy is deliberately not set: `require-corp` would block the wallets' cross-origin
 * frames and icons, and nothing here needs cross-origin isolation (no SharedArrayBuffer).
 */

/** Enforced: anti-framing, no <base> or form hijacking, no plugins. Cannot break the app or wallets. */
export const CSP_ENFORCED = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

/** The strict target policy, reported but not enforced yet. The dashboard itself produces no violations (tested). */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https: data: blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export interface HeaderContext {
  /** Request path, e.g. "/", "/api/v1/health", "/docs/static/index.html". */
  url: string;
  /** True when the client connected over HTTPS (behind the TLS proxy, with trustProxy). */
  https: boolean;
}

/** PURE: the security headers for one response. */
export function securityHeaders(ctx: HeaderContext): Record<string, string> {
  const isApi = ctx.url.startsWith("/api/");
  const isDocs = ctx.url === "/docs" || ctx.url.startsWith("/docs/");
  const h: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": ctx.https ? `${CSP_ENFORCED}; upgrade-insecure-requests` : CSP_ENFORCED,
    // Isolates this window from cross-origin openers, but keeps the wallet popups it opens (MyNearWallet, Meteor) working.
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": isApi ? "same-origin" : "same-site",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
  // Swagger UI (/docs) ships inline bootstrap code; keep the report-only policy for the dashboard and API only.
  if (!isDocs) h["content-security-policy-report-only"] = CSP_REPORT_ONLY;
  return h;
}
