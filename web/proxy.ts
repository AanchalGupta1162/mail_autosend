// Runs before every page request: per-request CSP nonce + auth guard. Unauthenticated
// visitors are redirected before any app page renders (no flash of private UI). The session
// is checked against the backend's GET /api/auth/me; any failure fails closed.
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, securityHeaders } from "./lib/csp";
import { guardRedirect } from "./lib/guard";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const SESSION_COOKIE = "sid";

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  if (!request.cookies.has(SESSION_COOKIE)) return false;
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/me`, {
      headers: { cookie: request.headers.get("cookie") ?? "", accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      // Generous: a suspended Neon compute can take a few seconds to wake. Timeout => fail closed.
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function harden(res: NextResponse, csp: string) {
  res.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries(securityHeaders(process.env.NODE_ENV))) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", https });

  const { pathname, search } = request.nextUrl;
  const target = guardRedirect(pathname, search, await isAuthenticated(request));
  if (target) return harden(NextResponse.redirect(new URL(target, request.url)), csp);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  return harden(NextResponse.next({ request: { headers: requestHeaders } }), csp);
}

export const config = {
  // Pages only: the API is proxied by the rewrite in next.config.ts, static assets need no guard.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
