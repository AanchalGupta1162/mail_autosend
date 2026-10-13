// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCsp, securityHeaders, SECURITY_HEADERS } from "./csp";

const directives = (csp: string) =>
  Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [k, ...v] = d.split(/\s+/);
    return [k, v];
  }));

describe("buildCsp", () => {
  it("production: nonce-based scripts and styles, nothing inline or eval", () => {
    const csp = buildCsp("abc123", { dev: false, https: true });
    const d = directives(csp);
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d["style-src"]).toEqual(["'self'", "'nonce-abc123'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect("upgrade-insecure-requests" in d).toBe(true);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });
  it("development adds only what the dev server needs", () => {
    const d = directives(buildCsp("n", { dev: true, https: false }));
    expect(d["script-src"]).toContain("'unsafe-eval'");
    expect("upgrade-insecure-requests" in d).toBe(false);
  });
  it("ships the baseline security headers", () => {
    expect(SECURITY_HEADERS).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
  });
});

describe("securityHeaders (HSTS)", () => {
  it("production adds a one-year HSTS header; development never sends it", () => {
    expect(securityHeaders("production")["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect("Strict-Transport-Security" in securityHeaders("development")).toBe(false);
    expect("Strict-Transport-Security" in securityHeaders("test")).toBe(false);
    expect("Strict-Transport-Security" in securityHeaders(undefined)).toBe(false);
  });
  it("always includes the baseline headers", () => {
    expect(securityHeaders("production")).toMatchObject(SECURITY_HEADERS);
    expect(securityHeaders("development")).toMatchObject(SECURITY_HEADERS);
  });
});
