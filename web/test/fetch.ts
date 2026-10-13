import { vi } from "vitest";

export type Seen = { url: string; method: string; body: unknown; headers: Headers };

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Stubs global fetch: CSRF is answered automatically, everything else goes to `handler`.
export function stubFetch(handler: (c: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const c: Seen = { url: String(input), method: (init.method ?? "GET").toUpperCase(), body: init.body, headers: new Headers(init.headers) };
      if (c.url === "/api/auth/csrf") return json({ csrfToken: "t" });
      seen.push(c);
      return handler(c);
    }),
  );
  return seen;
}
