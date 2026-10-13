import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, TEST_PASSWORD } from "../helpers/app.js";
import { createApp } from "../../src/server/app.js";
import { loadServerConfig } from "../../src/server/env.js";

const GENERIC = "Invalid username or password";
let t;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
});
after(async () => t?.close());

test("createApp refuses a short SESSION_SECRET", () => {
  const config = { ...t.config, sessionSecret: "short" };
  assert.throws(() => createApp({ pool: t.pool, config }), /SESSION_SECRET/);
});

test("/healthz is public and returns no data", async () => {
  const r = await t.client().get("/healthz");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test("helmet headers and strict CSP; x-powered-by off", async () => {
  const r = await t.client().get("/healthz");
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok(r.headers.get("x-frame-options") || /frame-ancestors/.test(r.headers.get("content-security-policy")));
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("unauthenticated API access is 401 (deny by default), even for unknown routes", async () => {
  const c = t.client();
  for (const p of ["/api/auth/me", "/api/batches", "/api/anything"]) {
    const r = await c.get(p);
    assert.equal(r.status, 401, p);
    assert.ok(r.json.error);
  }
});

test("unknown non-API route is a JSON 404 with no stack", async () => {
  const r = await t.client().get("/nope");
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Not found" });
});

test("csrf endpoint is public and sets a session cookie with safe flags", async () => {
  const c = t.client();
  const r = await c.fetchCsrf();
  assert.equal(r.status, 200);
  assert.match(r.json.csrfToken, /^[A-Za-z0-9_-]{32,}$/);
  const sc = r.setCookie.find((x) => x.startsWith("sid="));
  assert.ok(sc, "sid cookie set");
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.match(sc, /Path=\//);
  assert.doesNotMatch(sc, /Secure/i); // test env is not production
  const again = await c.get("/api/auth/csrf");
  assert.equal(again.json.csrfToken, r.json.csrfToken);
});

test("login without or with a bad CSRF token is 403", async () => {
  const c = t.client();
  let r = await c.post("/api/auth/login", { username: "admin", password: TEST_PASSWORD });
  assert.equal(r.status, 403);
  await c.fetchCsrf();
  r = await c.post("/api/auth/login", { username: "admin", password: TEST_PASSWORD }, { headers: { "x-csrf-token": "x".repeat(43) } });
  assert.equal(r.status, 403);
  r = await c.post("/api/auth/login", { username: "admin", password: TEST_PASSWORD }, { headers: { "x-csrf-token": "short" } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "Invalid CSRF token" });
});

test("login success: session id regenerated, new csrf token, cookie flags, me works", async () => {
  const c = t.client();
  await c.fetchCsrf();
  const before = c.sid;
  const preCsrf = c.csrf;
  const r = await c.post("/api/auth/login", { username: "ADMIN", password: TEST_PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.username, "admin");
  assert.ok(!JSON.stringify(r.json).includes("scrypt"));
  assert.notEqual(c.sid, before, "session id must change on login");
  assert.notEqual(r.json.csrfToken, preCsrf);
  const sc = r.setCookie.find((x) => x.startsWith("sid="));
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  c.csrf = r.json.csrfToken;
  const me = await c.get("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, "admin");
  // the pre-login session id no longer works
  const old = t.client();
  old.cookies.set("sid", before);
  assert.equal((await old.get("/api/auth/me")).status, 401);
});

test("login failures all return the same generic message (unknown user, wrong pw, bad body)", async () => {
  const c = t.client();
  await c.fetchCsrf();
  const a = await c.post("/api/auth/login", { username: "nobody", password: "whatever-pass" });
  const b = await c.post("/api/auth/login", { username: "admin", password: "wrong-password-x" });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(a.json, { error: GENERIC });
  assert.deepEqual(b.json, { error: GENERIC });
  const bad = await c.post("/api/auth/login", { username: "admin" });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, { error: GENERIC });
  const extra = await c.post("/api/auth/login", { username: "admin", password: TEST_PASSWORD, admin: true });
  assert.equal(extra.status, 401);
});

test("unknown-user login does equal (scrypt) work", async () => {
  const c = t.client();
  await c.fetchCsrf();
  const t0 = performance.now();
  await c.post("/api/auth/login", { username: "ghost-user", password: "whatever-pass" });
  assert.ok(performance.now() - t0 > 20, "dummy hash must be verified");
});

test("logout needs csrf, destroys the session server-side", async () => {
  const c = t.client();
  await c.login();
  const sid = c.sid;
  assert.equal((await c.post("/api/auth/logout", {}, { headers: { "x-csrf-token": "nope" } })).status, 403);
  assert.equal((await c.post("/api/auth/logout", {})).status, 200);
  const { rows } = await t.pool.query("select 1 from session where sid=$1", [sid]);
  assert.equal(rows.length, 0);
  const replay = t.client();
  replay.cookies.set("sid", sid);
  assert.equal((await replay.get("/api/auth/me")).status, 401);
});

test("state-changing requests without csrf are 403 when authenticated", async () => {
  const c = t.client();
  await c.login();
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await c.raw(m, "/api/anything", { csrf: false, body: {} });
    assert.equal(r.status, 403, m);
  }
  const ok = await c.raw("DELETE", "/api/anything");
  assert.equal(ok.status, 404); // csrf passes, route does not exist
  assert.deepEqual(ok.json, { error: "Not found" });
});

test("lockout after 5 consecutive failures, even with the right password; DB-backed", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("victim");
    const c = t2.client();
    await c.fetchCsrf();
    for (let i = 0; i < 5; i++) {
      const r = await c.post("/api/auth/login", { username: "victim", password: "bad-password-" + i });
      assert.equal(r.status, 401);
    }
    const { rows } = await t2.pool.query("select failed_attempts, locked_until from users where username='victim'");
    assert.equal(rows[0].failed_attempts, 5);
    assert.ok(rows[0].locked_until > new Date());
    const r = await c.post("/api/auth/login", { username: "victim", password: TEST_PASSWORD });
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: GENERIC });
    // lock expiry restores access and success resets the counter
    await t2.pool.query("update users set locked_until = now() - interval '1 second' where username='victim'");
    const ok = await c.post("/api/auth/login", { username: "victim", password: TEST_PASSWORD });
    assert.equal(ok.status, 200);
    const after = await t2.pool.query("select failed_attempts, locked_until from users where username='victim'");
    assert.equal(after.rows[0].failed_attempts, 0);
    assert.equal(after.rows[0].locked_until, null);
  } finally {
    await t2.close();
  }
});

test("a success before the 5th failure resets the counter", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("u2");
    const c = t2.client();
    await c.fetchCsrf();
    for (let i = 0; i < 4; i++) await c.post("/api/auth/login", { username: "u2", password: "bad-password-x" });
    assert.equal((await c.login("u2")).status, 200);
    const { rows } = await t2.pool.query("select failed_attempts from users where username='u2'");
    assert.equal(rows[0].failed_attempts, 0);
  } finally {
    await t2.close();
  }
});

test("per-IP rate limit on login: 11th attempt in the window is 429 (production default)", async () => {
  const t2 = await startTestApp({}, { defaultRateLimit: true });
  try {
    await t2.addUser("rl");
    const c = t2.client();
    await c.fetchCsrf();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await c.post("/api/auth/login", { username: "nobody-" + i, password: "x".repeat(12) })).status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);
  } finally {
    await t2.close();
  }
});

test("change-password: auth, csrf, current pw, min length, must differ, then works", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("cp");
    const anon = t2.client();
    assert.equal((await anon.post("/api/auth/change-password", {})).status, 401);
    const c = t2.client();
    await c.login("cp");
    const url = "/api/auth/change-password";
    assert.equal((await c.post(url, { currentPassword: TEST_PASSWORD, newPassword: "new-password-1" }, { headers: { "x-csrf-token": "bad" } })).status, 403);
    assert.equal((await c.post(url, { currentPassword: "wrong-password", newPassword: "new-password-1" })).status, 400);
    assert.equal((await c.post(url, { currentPassword: TEST_PASSWORD, newPassword: "short" })).status, 400);
    assert.equal((await c.post(url, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })).status, 400);
    assert.equal((await c.post(url, { currentPassword: TEST_PASSWORD, newPassword: "new-password-1", extra: 1 })).status, 400);
    const sidBefore = c.sid;
    const ok = await c.post(url, { currentPassword: TEST_PASSWORD, newPassword: "new-password-1" });
    assert.equal(ok.status, 200);
    assert.notEqual(c.sid, sidBefore, "session rotated on password change");
    c.csrf = ok.json.csrfToken;
    assert.equal((await c.get("/api/auth/me")).status, 200);
    const { rows } = await t2.pool.query("select password_hash from users where username='cp'");
    assert.ok(!rows[0].password_hash.includes("new-password-1"));
    const c2 = t2.client();
    assert.equal((await c2.login("cp", TEST_PASSWORD)).status, 401);
    assert.equal((await c2.login("cp", "new-password-1")).status, 200);
  } finally {
    await t2.close();
  }
});

test("change-password wrong-current attempts count toward lockout", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("cp2");
    const c = t2.client();
    await c.login("cp2");
    for (let i = 0; i < 5; i++) {
      await c.post("/api/auth/change-password", { currentPassword: "wrong-password-" + i, newPassword: "new-password-1" });
    }
    const { rows } = await t2.pool.query("select locked_until from users where username='cp2'");
    assert.ok(rows[0].locked_until > new Date());
    const r = await c.post("/api/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: "new-password-1" });
    assert.equal(r.status, 400);
  } finally {
    await t2.close();
  }
});

test("errors: malformed JSON -> 400, oversized body -> 413, no stack or SQL leakage", async () => {
  const c = t.client();
  await c.fetchCsrf();
  const bad = await c.raw("POST", "/api/auth/login", { rawBody: "{not json", headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.json), ["error"]);
  assert.doesNotMatch(bad.text, /at .*\.js|SyntaxError|node_modules/);
  const big = await c.raw("POST", "/api/auth/login", {
    rawBody: JSON.stringify({ username: "a", password: "x".repeat(200_000) }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(big.status, 413);
  assert.deepEqual(Object.keys(big.json), ["error"]);
});

test("internal errors return a generic 500 without details", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("e1");
    const c = t2.client();
    await c.fetchCsrf();
    await t2.pool.query("drop table session");
    const r = await c.get("/api/auth/csrf");
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: "Internal server error" });
    assert.doesNotMatch(r.text, /session|relation|SELECT|INSERT|\.js/i);
  } finally {
    await t2.close();
  }
});

test("concurrent wrong logins cannot lose lockout updates", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("race");
    const c = t2.client();
    await c.fetchCsrf();
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => c.post("/api/auth/login", { username: "race", password: "bad-password-" + i })),
    );
    assert.ok(rs.every((r) => r.status === 401));
    const { rows } = await t2.pool.query("select failed_attempts, locked_until from users where username='race'");
    assert.equal(rows[0].failed_attempts, 5, "exactly 5 counted; attempts while locked are not counted");
    assert.ok(rows[0].locked_until > new Date());
  } finally {
    await t2.close();
  }
});

test("a burst including the correct password never succeeds once the account is locked", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("burst");
    const c = t2.client();
    await c.fetchCsrf();
    for (let i = 0; i < 5; i++) await c.post("/api/auth/login", { username: "burst", password: "bad-password-" + i });
    const rs = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => c.post("/api/auth/login", { username: "burst", password: "bad-x-" + i })),
      ...Array.from({ length: 4 }, () => c.post("/api/auth/login", { username: "burst", password: TEST_PASSWORD })),
    ]);
    assert.ok(rs.every((r) => r.status === 401 && r.json.error === GENERIC));
  } finally {
    await t2.close();
  }
});
