import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";

type Call = { url: string; method: string; headers: Headers; body: unknown };

// Minimal fake backend: `handler` decides the response for each non-CSRF call.
function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>, tokens = ["tok-1", "tok-2", "tok-3"]) {
  const calls: Call[] = [];
  let csrfCount = 0;
  let n = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: (init.method ?? "GET").toUpperCase(),
      headers: new Headers(init.headers),
      body: init.body,
    };
    calls.push(call);
    if (call.url === "/api/auth/csrf") return json({ csrfToken: tokens[csrfCount++] });
    return handler(call, n++);
  });
  return { fn: fn as unknown as typeof fetch, calls, csrfCalls: () => calls.filter((c) => c.url === "/api/auth/csrf").length };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client CSRF handling", () => {
  it("fetches the CSRF token once and sends it on every mutating call", async () => {
    const f = fakeFetch(() => json({ contact: { id: "c1" } }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.markReplied("c1");
    await api.optOut("c2");
    expect(f.csrfCalls()).toBe(1);
    const mutating = f.calls.filter((c) => c.method === "POST");
    expect(mutating).toHaveLength(2);
    for (const c of mutating) expect(c.headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("shares one CSRF fetch between concurrent mutating calls", async () => {
    const f = fakeFetch(() => json({ contact: { id: "c" } }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await Promise.all([api.markReplied("a"), api.markReplied("b"), api.optOut("c")]);
    expect(f.csrfCalls()).toBe(1);
  });

  it("does not fetch a token or send the header for GET requests", async () => {
    const f = fakeFetch(() => json({ batches: [] }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.listBatches();
    expect(f.csrfCalls()).toBe(0);
    expect(f.calls[0]!.headers.get("X-CSRF-Token")).toBeNull();
  });

  it("on 403 refetches the token and retries exactly once", async () => {
    const f = fakeFetch((_c, n) => (n === 0 ? json({ error: "Invalid CSRF token" }, 403) : json({ contact: { id: "c1" } })));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const contact = await api.markReplied("c1");
    expect(contact).toEqual({ id: "c1" });
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.headers.get("X-CSRF-Token"))).toEqual(["tok-1", "tok-2"]);
    expect(f.csrfCalls()).toBe(2);
  });

  it("does not retry a 403 that is not the backend's CSRF error", async () => {
    for (const body of [{ error: "Forbidden" }, null, { error: "invalid csrf token " }]) {
      const f = fakeFetch(() => (body ? json(body, 403) : new Response("", { status: 403 })));
      const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
      await expect(api.markReplied("c1")).rejects.toMatchObject({ status: 403 });
      expect(f.calls.filter((c) => c.method === "POST"), JSON.stringify(body)).toHaveLength(1);
      expect(f.csrfCalls()).toBe(1);
    }
  });

  it("gives up after one retry when the token is still refused", async () => {
    const f = fakeFetch(() => json({ error: "Invalid CSRF token" }, 403));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await expect(api.markReplied("c1")).rejects.toMatchObject({ status: 403 });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("keeps the rotated token returned by login and by change-password", async () => {
    const f = fakeFetch((c) => {
      if (c.url === "/api/auth/login") return json({ user: { id: "u", username: "admin" }, csrfToken: "after-login" });
      if (c.url === "/api/auth/change-password") return json({ ok: true, csrfToken: "after-change" });
      return json({ contact: {} });
    });
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.login("admin", "pw");
    await api.markReplied("x");
    await api.changePassword("old-password", "new-password-123");
    await api.optOut("y");
    const tokens = f.calls.filter((c) => c.method !== "GET").map((c) => [c.url, c.headers.get("X-CSRF-Token")]);
    expect(tokens).toEqual([
      ["/api/auth/login", "tok-1"],
      ["/api/contacts/x/mark-replied", "after-login"],
      ["/api/auth/change-password", "after-login"],
      ["/api/contacts/y/opt-out", "after-change"],
    ]);
  });

  it("sends credentials same-origin and JSON bodies", async () => {
    const f = fakeFetch(() => json({ message: { id: "m" } }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.scheduleContact("c1", "2030-01-01T09:00:00.000Z");
    const spy = f.fn as unknown as ReturnType<typeof vi.fn>;
    const init = spy.mock.calls.at(-1)![1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(f.calls.at(-1)!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(f.calls.at(-1)!.body))).toEqual({ sendAt: "2030-01-01T09:00:00.000Z" });
  });
});

describe("api client 401 and errors", () => {
  it("calls onUnauthorized on 401 and rejects", async () => {
    const onUnauthorized = vi.fn();
    const f = fakeFetch(() => json({ error: "Authentication required" }, 401));
    const api = createApi({ fetch: f.fn, onUnauthorized });
    await expect(api.getDashboard()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a failed login is an error to show, not a redirect", async () => {
    const onUnauthorized = vi.fn();
    const f = fakeFetch(() => json({ error: "Invalid username or password" }, 401));
    const api = createApi({ fetch: f.fn, onUnauthorized });
    await expect(api.login("admin", "nope")).rejects.toMatchObject({ status: 401, message: "Invalid username or password" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("exposes the refusal list of a 409 schedule response", async () => {
    const refused = [{ contactId: "c1", email: "a@x.com", reason: "replied" }];
    const f = fakeFetch(() => json({ error: "Some contacts cannot be scheduled", refused }, 409));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const err = await api.scheduleBatch("b1", { contactIds: ["c1"], sendAt: "2030-01-01T09:00:00.000Z" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.refused).toEqual(refused);
  });

  it("exposes row errors of a 422 upload and sends multipart without a JSON content-type", async () => {
    const errors = [{ row: 2, message: "Email is not a valid address" }];
    const f = fakeFetch(() => json({ error: "No valid rows to import", errors }, 422));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    const file = new File(["a,b"], "leads.csv", { type: "text/csv" });
    const err = await api.uploadBatch(file, "Leads").catch((e) => e);
    expect(err.rowErrors).toEqual(errors);
    const upload = f.calls.find((c) => c.url === "/api/batches")!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect(upload.headers.get("content-type")).toBeNull();
    expect(upload.headers.get("X-CSRF-Token")).toBe("tok-1");
  });

  it("maps network failures to a readable ApiError", async () => {
    const api = createApi({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      onUnauthorized: vi.fn(),
    });
    await expect(api.getDashboard()).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/reach the server/i) });
  });

  it("builds the contacts query string from defined filters only", async () => {
    const f = fakeFetch(() => json({ contacts: [], total: 0, page: 1, pageSize: 25 }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.listContacts({ status: "sent", q: "acme co", page: 2 });
    expect(f.calls[0]!.url).toBe("/api/contacts?status=sent&q=acme+co&page=2");
  });

  it("uses the documented endpoints for scheduling, follow-up and cancel", async () => {
    const f = fakeFetch(() => json({ messages: [], message: {}, contact: {}, followup: null }));
    const api = createApi({ fetch: f.fn, onUnauthorized: vi.fn() });
    await api.scheduleBatch("b1", { contactIds: ["c1"], sendAt: "2030-01-01T09:00:00.000Z", staggerMinutes: 5 });
    await api.setFollowup("c1", { enabled: true, delayDays: 4 });
    await api.cancelMessage("m1");
    const sent = f.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url} ${c.body ?? ""}`);
    expect(sent).toEqual([
      'POST /api/batches/b1/schedule {"contactIds":["c1"],"sendAt":"2030-01-01T09:00:00.000Z","staggerMinutes":5}',
      'PUT /api/contacts/c1/followup {"enabled":true,"delayDays":4}',
      "DELETE /api/messages/m1 ",
    ]);
  });
});
