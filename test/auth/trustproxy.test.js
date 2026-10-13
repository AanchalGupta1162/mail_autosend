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
