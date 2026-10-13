// Route guard decisions, shared by proxy.ts. Pure so it can be unit-tested.

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/dashboard";

/** Only same-origin app paths are accepted as a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return HOME_PATH;
  if (/^\/(login|api)(\/|\?|$)/.test(next)) return HOME_PATH;
  return next;
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
