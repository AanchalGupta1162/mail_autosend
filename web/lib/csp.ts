// Content-Security-Policy for every page response (set per request by proxy.ts with a fresh nonce).

export function buildCsp(nonce: string, { dev, https }: { dev: boolean; https: boolean }): string {
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    // React's dev tooling needs eval; production never does.
    ["script-src", "'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    // The dev server injects <style> tags without a nonce; production styles are linked files
    // plus Next's nonce-tagged inline styles. No style attributes are used by this app.
    ["style-src", "'self'", ...(dev ? ["'unsafe-inline'"] : [`'nonce-${nonce}'`])],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'"],
    ["object-src", "'none'"],
    ["frame-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ...(https ? ([["upgrade-insecure-requests"]] as [string][]) : []),
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/** Static hardening headers (next.config.ts applies them to every route, proxy.ts to redirects). */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * SECURITY_HEADERS plus HSTS in production. Never in development: a browser that saw HSTS for
 * localhost would refuse plain-http dev servers afterwards. Browsers ignore it over plain http.
 */
export function securityHeaders(nodeEnv: string | undefined): Record<string, string> {
  return nodeEnv === "production"
    ? { ...SECURITY_HEADERS, "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : { ...SECURITY_HEADERS };
}
