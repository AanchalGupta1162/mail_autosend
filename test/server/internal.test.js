import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

const AUD = "https://mail-backend-test.a.run.app";
const SA = "scheduler-invoker@proj.iam.gserviceaccount.com";
const ENV = {
  INTERNAL_AUDIENCE: AUD,
  INTERNAL_INVOKER_SA: SA,
  MAX_PER_TICK: "2",
  SEND_GAP_SECONDS_MIN: "0",
  SEND_GAP_SECONDS_MAX: "0",
};

// Injected verifier: no network. Tokens are plain labels that map to payloads.
const calls = [];
const PAYLOADS = {
  good: { email: SA, email_verified: true, aud: AUD },
  "other-sa": { email: "someone-else@proj.iam.gserviceaccount.com", email_verified: true },
  unverified: { email: SA, email_verified: false },
  "no-email": { sub: "123" },
  "case-mismatch": { email: SA.toUpperCase(), email_verified: true },
};
async function verifier(token, audience) {
  calls.push({ token, audience });
  if (!(token in PAYLOADS)) throw new Error("bad token with secret details");
  return PAYLOADS[token];
}

const sent = [];
function mailer(delayMs = 0) {
  return {
    async sendMail(o) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      sent.push(o.messageId);
      return { messageId: o.messageId };
    },
  };
}

let t;
const shutdown = new AbortController();
before(async () => {
  t = await startTestApp(ENV, { appOptions: { internalVerifier: verifier, shutdownSignal: shutdown.signal, mailer: mailer(), checkReply: async () => null } });
});
after(async () => t?.close());
beforeEach(async () => {
  calls.length = 0;
  sent.length = 0;
  await t.pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
  await t.pool.query("DELETE FROM settings WHERE key IN ('send_hold','send_window','sweep_state')");
});

const post = (p, token, headers = {}) =>
  fetch(t.url + p, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

async function dueInitials(count, pool = t.pool) {
  const emails = Array.from({ length: count }, (_, i) => `int${Date.now()}${i}@example.com`);
  const { contacts } = await seedBatch(pool, emails, { overrides: Object.fromEntries(emails.map((e) => [e, { status: "scheduled" }])) });
  for (const c of contacts) await addMessage(pool, c.id, { scheduledFor: new Date("2026-10-01T00:00:00Z") });
  return contacts;
}

for (const route of ["/internal/tick", "/internal/sweep"]) {
  test(`${route}: missing, malformed and invalid tokens are 401 and leak nothing`, async () => {
    for (const [label, headers] of [
      ["no header", {}],
      ["basic scheme", { authorization: "Basic abc" }],
      ["empty bearer", { authorization: "Bearer " }],
      ["unknown token", { authorization: "Bearer garbage" }],
    ]) {
      const r = await post(route, null, headers);
      assert.equal(r.status, 401, label);
      assert.deepEqual(r.json, { error: "Unauthorized" }, label);
    }
    assert.equal(sent.length, 0);
  });

  test(`${route}: a valid token from the wrong service account, unverified email or no email is 403`, async () => {
    for (const tok of ["other-sa", "unverified", "no-email", "case-mismatch"]) {
      const r = await post(route, tok);
      assert.equal(r.status, 403, tok);
      assert.deepEqual(r.json, { error: "Forbidden" }, tok);
    }
  });

  test(`${route}: a browser session is not enough (no bearer token is 401 even when logged in with CSRF)`, async () => {
    await t.addUser("admin").catch(() => {});
    const c = t.client();
    await c.login();
    const r = await c.raw("POST", route, {});
    assert.equal(r.status, 401);
  });

  test(`${route}: the verifier receives the token and the configured audience`, async () => {
    await post(route, "good");
    assert.deepEqual(calls[0], { token: "good", audience: AUD });
  });
}

test("GET on /internal/* is never served (auth first, then 404)", async () => {
  assert.equal((await fetch(t.url + "/internal/tick")).status, 401);
  const r = await fetch(t.url + "/internal/tick", { headers: { authorization: "Bearer good" } });
  assert.equal(r.status, 404);
});

test("the default verifier rejects a garbage token locally (no network) with 401", async () => {
  const t2 = await startTestApp(ENV); // no injected verifier
  try {
    const r = await fetch(t2.url + "/internal/tick", { method: "POST", headers: { authorization: "Bearer not.a.jwt" } });
    assert.equal(r.status, 401);
  } finally {
    await t2.close();
  }
});

test("without INTERNAL_AUDIENCE/INTERNAL_INVOKER_SA the routes fail closed (401, verifier never consulted)", async () => {
  const t2 = await startTestApp({}, { appOptions: { internalVerifier: verifier } });
  try {
    const r = await fetch(t2.url + "/internal/tick", { method: "POST", headers: { authorization: "Bearer good" } });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  } finally {
    await t2.close();
  }
});

test("everything else still needs a session: no /api route is reachable with an OIDC token", async () => {
  for (const p of ["/api/dashboard", "/api/sweep", "/api/settings/send-window", "/api/auth/me"]) {
    const r = await fetch(t.url + p, { method: p === "/api/sweep" ? "POST" : "GET", headers: { authorization: "Bearer good" } });
    assert.equal(r.status, 401, p);
  }
});

test("/internal/tick drains every due message across several runTick iterations", async () => {
  await dueInitials(5);
  const r = await post("/internal/tick", "good");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.reason, "idle");
  assert.equal(r.json.summary.sent, 5);
  assert.equal(r.json.summary.claimed, 5);
  assert.equal(r.json.iterations, 4, "2 + 2 + 1 + one empty tick");
  assert.equal(sent.length, 5);
  assert.equal((await t.pool.query("SELECT count(*)::int n FROM messages WHERE state='sent'")).rows[0].n, 5);
});

test("/internal/tick with nothing due returns idle after one iteration", async () => {
  const r = await post("/internal/tick", "good");
  assert.deepEqual({ status: r.status, reason: r.json.reason, iterations: r.json.iterations, sent: r.json.summary.sent }, { status: 200, reason: "idle", iterations: 1, sent: 0 });
});

test("/internal/tick stops at its deadline and leaves the rest scheduled", async () => {
  const t2 = await startTestApp({ ...ENV, MAX_PER_TICK: "1", INTERNAL_TICK_DEADLINE_SECONDS: "1" }, { appOptions: { internalVerifier: verifier, mailer: mailer(1200) } });
  try {
    await dueInitials(3, t2.pool);
    const r = await fetch(t2.url + "/internal/tick", { method: "POST", headers: { authorization: "Bearer good" } });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.reason, "deadline");
    assert.equal(j.summary.sent, 1);
    assert.equal((await t2.pool.query("SELECT count(*)::int n FROM messages WHERE state='scheduled'")).rows[0].n, 2);
  } finally {
    await t2.close();
  }
});

test("/internal/tick stops with reason window_closed when real sends are outside the enforced window", async () => {
  const real = {
    ...ENV,
    DRY_RUN: "false",
    SEND_WINDOW_ENFORCED: "true",
    GMAIL_USER: "me@example.com",
    GMAIL_APP_PASSWORD: "pw",
    SIGNATURE_HTML: "<p>sig</p>",
    RESUME_PATH: path.resolve("test/fixtures/resume.pdf"),
  };
  const t2 = await startTestApp(real, { appOptions: { internalVerifier: verifier, mailer: mailer() } });
  try {
    await dueInitials(2, t2.pool);
    const h = new Date().getUTCHours();
    const start = h < 12 ? "20:00" : "02:00";
    const end = h < 12 ? "21:00" : "03:00";
    await t2.pool.query("INSERT INTO settings(key, value) VALUES ('send_window', $1::jsonb)", [JSON.stringify({ start, end, tz: "UTC" })]);
    const r = await fetch(t2.url + "/internal/tick", { method: "POST", headers: { authorization: "Bearer good" } });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.reason, "window_closed");
    assert.equal(j.iterations, 1);
    assert.equal(j.summary.sent, 0);
    assert.equal(sent.length, 0);
  } finally {
    await t2.close();
  }
});

test("/internal/tick is single-flight: an overlapping call is skipped, not run in parallel", async () => {
  const t2 = await startTestApp({ ...ENV, MAX_PER_TICK: "1" }, { appOptions: { internalVerifier: verifier, mailer: mailer(500) } });
  try {
    await dueInitials(2, t2.pool);
    const call = () => fetch(t2.url + "/internal/tick", { method: "POST", headers: { authorization: "Bearer good" } }).then((r) => r.json());
    const first = call();
    await new Promise((r) => setTimeout(r, 150));
    const second = await call();
    assert.deepEqual(second, { ok: true, skipped: true, reason: "in_progress" });
    const done = await first;
    assert.equal(done.summary.sent, 2);
  } finally {
    await t2.close();
  }
});

test("/internal/tick honours shutdown: aborted signal means no claims at all", async () => {
  const ac = new AbortController();
  const t2 = await startTestApp(ENV, { appOptions: { internalVerifier: verifier, shutdownSignal: ac.signal, mailer: mailer() } });
  try {
    await dueInitials(2, t2.pool);
    ac.abort();
    const r = await fetch(t2.url + "/internal/tick", { method: "POST", headers: { authorization: "Bearer good" } });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.reason, "shutdown");
    assert.equal(j.summary.claimed, 0);
    assert.equal((await t2.pool.query("SELECT count(*)::int n FROM messages WHERE state='scheduled'")).rows[0].n, 2);
  } finally {
    await t2.close();
  }
});

test("/internal/sweep runs the existing single-flight sweep and returns its summary", async () => {
  const r = await post("/internal/sweep", "good");
  assert.equal(r.status, 200);
  // test config is dry-run: runSweep reports skipped(dry_run) unless a checker is injected; here one is
  assert.deepEqual(r.json, { ok: true, result: { checked: 0, replied: 0, rowErrors: 0, ok: true } });
});

test("/internal/sweep: a sweep already running is 200 skipped in_progress", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const t2 = await startTestApp(ENV, { appOptions: { internalVerifier: verifier, checkReply: async () => { await gate; return null; } } });
  try {
    await dueInitials(1, t2.pool);
    await t2.pool.query("UPDATE contacts SET status='sent'");
    await t2.pool.query("UPDATE messages SET state='sent', sent_at=now(), message_id='<a@b>'");
    const call = () => fetch(t2.url + "/internal/sweep", { method: "POST", headers: { authorization: "Bearer good" } }).then((r) => r.json());
    const first = call();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await call(), { ok: true, result: { skipped: true, reason: "in_progress" } });
    release();
    assert.equal((await first).result.checked, 1);
  } finally {
    release();
    await t2.close();
  }
});

test("/internal/sweep honours shutdown (stops before checking anything)", async () => {
  const ac = new AbortController();
  let checked = 0;
  const t2 = await startTestApp(ENV, { appOptions: { internalVerifier: verifier, shutdownSignal: ac.signal, checkReply: async () => { checked++; return null; } } });
  try {
    await dueInitials(1, t2.pool);
    await t2.pool.query("UPDATE contacts SET status='sent'");
    await t2.pool.query("UPDATE messages SET state='sent', sent_at=now(), message_id='<a@b>'");
    ac.abort();
    const r = await fetch(t2.url + "/internal/sweep", { method: "POST", headers: { authorization: "Bearer good" } });
    assert.equal(r.status, 200);
    assert.equal(checked, 0);
  } finally {
    await t2.close();
  }
});

test("/internal/sweep logs ok=true for a healthy sweep so the success metric can exclude unhealthy ones", async () => {
  const lines = [];
  const logger = { info: (m, f) => lines.push({ m, f }), warn() {}, error() {}, debug() {} };
  const t2 = await startTestApp(ENV, { appOptions: { internalVerifier: verifier, checkReply: async () => null, logger } });
  try {
    const r = await fetch(t2.url + "/internal/sweep", { method: "POST", headers: { authorization: "Bearer good" } });
    assert.equal(r.status, 200);
    const entry = lines.find((l) => l.f?.event === "internal_sweep");
    assert.equal(entry?.f.ok, true);
  } finally {
    await t2.close();
  }
});
