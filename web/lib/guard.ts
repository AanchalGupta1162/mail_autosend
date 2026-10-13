// Route guard decisions, shared by proxy.ts. Pure so it can be unit-tested.

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/dashboard";

// Control characters (the WHATWG URL parser silently strips tab/CR/LF) and backslashes
// (parsed as "/") can turn "/\t/evil.com" into "//evil.com", so they are rejected outright.
const UNSAFE = /[\u0000-\u001f\u007f\\]/;
const BASE = "http://app.invalid";
const EXCLUDED = /^\/(login|api)(\/|\?|#|$)/i;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Only same-origin app paths are accepted as a post-login destination. Anything else
 * (other origins, scheme-relative, control characters, backslashes, encoded variants of
 * those, /login and /api) falls back to the dashboard.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || UNSAFE.test(next)) return HOME_PATH;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return HOME_PATH;
  }
  if (url.origin !== BASE) return HOME_PATH;
  const path = decode(url.pathname);
  if (path === null || UNSAFE.test(path) || path.includes("//") || EXCLUDED.test(path)) return HOME_PATH;
  const out = url.pathname + url.search + url.hash;
  return out.startsWith("//") ? HOME_PATH : out;
}

/** Where to redirect this request, or null to let it through. */
export function guardRedirect(pathname: string, search: string, authenticated: boolean): string | null {
  if (pathname === LOGIN_PATH) {
    return authenticated ? safeNext(new URLSearchParams(search).get("next")) : null;
  }
  if (!authenticated) {
    const dest = pathname + search;
    return dest === "/" ? LOGIN_PATH : `${LOGIN_PATH}?next=${encodeURIComponent(dest)}`;
  }
  return pathname === "/" ? HOME_PATH : null;
}
