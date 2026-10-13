import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";

// Behind the Next.js rewrite every request reaches Express from the proxy. The per-IP login
// limiter must key on the client address from X-Forwarded-For only when TRUST_PROXY says so.
async function attempts(t, xff, n) {
  const c = t.client();
  await c.fetchCsrf();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push((await c.post("/api/auth/login", { username: "nobody", password: "x".repeat(12) }, { headers: { "x-forwarded-for": xff(i) } })).status);
  }
  return out;
}

test("TRUST_PROXY=1: the login limiter keys on X-Forwarded-For (one client throttled, others not)", async () => {
  const t = await startTestApp({ TRUST_PROXY: "1" }, { defaultRateLimit: true });
  try {
    const same = await attempts(t, () => "203.0.113.7", 11);
    assert.deepEqual(same.slice(0, 10), Array(10).fill(401));
    assert.equal(same[10], 429);
    // A different client behind the same proxy is unaffected.
    assert.equal((await attempts(t, () => "203.0.113.8", 1))[0], 401);
    // Distinct clients never trip the limiter.
    const many = await attempts(t, (i) => `198.51.100.${i + 1}`, 12);
    assert.deepEqual(many, Array(12).fill(401));
  } finally {
    await t.close();
  }
});

test("TRUST_PROXY unset: X-Forwarded-For is ignored, so a spoofed header cannot dodge the limiter", async () => {
  const t = await startTestApp({}, { defaultRateLimit: true });
  try {
    const statuses = await attempts(t, (i) => `198.51.100.${i + 1}`, 11);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);
  } finally {
    await t.close();
  }
});

test("production without TRUST_PROXY logs a loud warning (secure cookie never set behind TLS termination); other combinations stay quiet", async () => {
  const warnings = [];
  const logger = { error() {}, info() {}, warn: (m) => warnings.push(String(m)) };
  for (const [env, expectWarn] of [
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "production", TRUST_PROXY: "1" }, false],
    [{ NODE_ENV: "development" }, false],
  ]) {
    warnings.length = 0;
    const t = await startTestApp(env, { appOptions: { logger } });
    try {
      assert.equal(warnings.some((w) => /TRUST_PROXY/.test(w) && /secure|TLS|HTTPS/i.test(w)), expectWarn, JSON.stringify(env));
    } finally {
      await t.close();
    }
  }
});

test("GET /api/auth/csrf is rate limited per IP (it creates a session row per anonymous request)", async () => {
  const t = await startTestApp({}, { appOptions: { csrfRateLimit: { limit: 3 } } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await t.client().get("/api/auth/csrf")).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    const { rows } = await t.pool.query("select count(*)::int n from session");
    assert.equal(rows[0].n, 3, "throttled requests create no session");
  } finally {
    await t.close();
  }
});

test("the default CSRF limit is generous enough for normal use", async () => {
  const t = await startTestApp({}, { defaultRateLimit: true });
  try {
    const c = t.client();
    for (let i = 0; i < 60; i++) assert.equal((await c.get("/api/auth/csrf")).status, 200);
  } finally {
    await t.close();
  }
});
