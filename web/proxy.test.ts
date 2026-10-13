// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const req = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, "http://localhost:3001"), { headers: cookie ? { cookie } : {} });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("proxy (auth guard + CSP)", () => {
  it("redirects an anonymous visitor to login without calling the backend", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await proxy(req("/contacts"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3001/login?next=%2Fcontacts");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  });

  it("redirects when the backend says the session is not valid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"Authentication required"}', { status: 401 })));
    const res = await proxy(req("/dashboard", "sid=stale"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("fails closed when the backend cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const res = await proxy(req("/dashboard", "sid=x"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("lets a valid session through with a per-request nonce CSP, forwarding only the cookie to /api/auth/me", async () => {
    const fetchSpy = vi.fn(async () => new Response('{"user":{"id":"u","username":"a"}}', { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const a = await proxy(req("/dashboard", "sid=good"));
    const b = await proxy(req("/dashboard", "sid=good"));
    expect(a.status).toBe(200);
    expect(a.headers.get("location")).toBeNull();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/me$/);
    expect(new Headers(init.headers).get("cookie")).toBe("sid=good");
    const nonce = (h: Headers) => /'nonce-([^']+)'/.exec(h.get("content-security-policy") ?? "")?.[1];
    expect(nonce(a.headers)).toBeTruthy();
    expect(nonce(a.headers)).not.toBe(nonce(b.headers));
  });

  it("never redirects a signed-in user off-origin via /login?next= (tab/newline/backslash tricks)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    for (const raw of ["/\t/evil.com", "/\n/evil.com", "/\r\\evil.com", "//evil.com", "/\\evil.com", "https://evil.com"]) {
      const res = await proxy(req(`/login?next=${encodeURIComponent(raw)}`, "sid=good"));
      expect(res.status, JSON.stringify(raw)).toBe(307);
      expect(new URL(res.headers.get("location")!).origin, JSON.stringify(raw)).toBe("http://localhost:3001");
    }
  });

  it("signed-in users hitting /login go to the dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const res = await proxy(req("/login", "sid=good"));
    expect(res.headers.get("location")).toBe("http://localhost:3001/dashboard");
  });
});

describe("proxy HSTS", () => {
  it("sends Strict-Transport-Security in production, including on the login redirect", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await proxy(req("/contacts"));
    expect(res.status).toBe(307);
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("does not send it in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await proxy(req("/contacts"));
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
