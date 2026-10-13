import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

let t, c;
before(async () => {
  t = await startTestApp({ DAILY_SEND_CAP: "50" });
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

const H = 3600_000;

test("dashboard and sweep require auth; sweep requires CSRF", async () => {
  const anon = t.client();
  assert.equal((await anon.get("/api/dashboard")).status, 401);
  assert.equal((await anon.post("/api/sweep", {})).status, 401);
  const noCsrf = t.client();
  await noCsrf.login();
  assert.equal((await noCsrf.raw("POST", "/api/sweep", { body: {}, csrf: false })).status, 403);
});

test("empty dashboard has zeroed numbers", async () => {
  const r = await c.get("/api/dashboard");
  assert.equal(r.status, 200);
  assert.equal(r.json.sentToday, 0);
  assert.equal(r.json.dailyCap, 50);
  assert.equal(r.json.repliedRate, 0);
  assert.deepEqual(r.json.upcoming, []);
  assert.deepEqual(r.json.byCompany, []);
  assert.equal(r.json.totals.sent, 0);
});

test("dashboard aggregates seeded states", async () => {
  const emails = ["a", "b", "c", "d", "e", "f"].map((x) => `${x}@dash.example.com`);
  const o = (company, status) => ({ company, status });
  const { contacts } = await seedBatch(t.pool, emails, {
    overrides: {
      [emails[0]]: o("Acme", "sent"),
      [emails[1]]: o("Acme", "replied"),
      [emails[2]]: o("Globex", "sent"),
      [emails[3]]: o("Globex", "scheduled"),
      [emails[4]]: o("Initech", "uploaded"),
      [emails[5]]: o("Initech", "opted_out"),
    },
  });
  const now = Date.now();
  // initials sent: 0,1,2 ; two within 24h, one older than 24h
  await addMessage(t.pool, contacts[0].id, { state: "sent", sentAt: new Date(now - 1 * H), messageId: "<1@x>" });
  await addMessage(t.pool, contacts[1].id, { state: "sent", sentAt: new Date(now - 2 * H), messageId: "<2@x>" });
  await addMessage(t.pool, contacts[2].id, { state: "sent", sentAt: new Date(now - 30 * H), messageId: "<3@x>" });
  // a dry-run send must not count toward sentToday (server is DRY_RUN=true by default, so flip: real sends are excluded)
  await addMessage(t.pool, contacts[3].id, { state: "scheduled", scheduledFor: new Date(now + 5 * H) });
  await t.pool.query("insert into events(contact_id, type, meta) values ($1,'sent','{}')", [contacts[0].id]);
  const r = (await c.get("/api/dashboard")).json;
  assert.equal(r.totals.sent, 2);
  assert.equal(r.totals.replied, 1);
  assert.equal(r.totals.scheduled, 1);
  assert.equal(r.totals.uploaded, 1);
  assert.equal(r.totals.opted_out, 1);
  assert.equal(r.totals.bounced, 0);
  assert.equal(r.sentToday, 0, "default config is dry-run; these sends are real so excluded");
  assert.equal(r.repliedRate, +(1 / 3).toFixed(4));
  assert.equal(r.upcoming.length, 1);
  assert.equal(r.upcoming[0].contactId, contacts[3].id);
  assert.equal(r.upcoming[0].email, emails[3]);
  assert.equal(r.recentEvents[0].type, "sent");
  assert.equal(r.recentEvents[0].email, emails[0]);
  const acme = r.byCompany.find((x) => x.company === "Acme");
  assert.deepEqual(acme, { company: "Acme", total: 2, sent: 2, replied: 1 });
  assert.equal(r.byCompany[0].total >= r.byCompany[r.byCompany.length - 1].total, true);
});

test("sentToday counts only same-mode sends in the last 24h", async () => {
  const real = await startTestApp({ DRY_RUN: "false", GMAIL_USER: "a@b.c", GMAIL_APP_PASSWORD: "x" });
  try {
    await real.addUser("admin");
    const rc = real.client();
    await rc.login();
    const { contacts } = await seedBatch(real.pool, ["x@d.example.com", "y@d.example.com", "z@d.example.com"]);
    await addMessage(real.pool, contacts[0].id, { state: "sent", sentAt: new Date(Date.now() - H), dryRun: false });
    await addMessage(real.pool, contacts[1].id, { state: "sent", sentAt: new Date(Date.now() - H), dryRun: true });
    await addMessage(real.pool, contacts[2].id, { state: "sent", sentAt: new Date(Date.now() - 30 * H), dryRun: false });
    assert.equal((await rc.get("/api/dashboard")).json.sentToday, 1);
  } finally {
    await real.close();
  }
});

test("dashboard caps upcoming at 10 and recentEvents at 20", async () => {
  const emails = Array.from({ length: 12 }, (_, i) => `cap${i}@dash.example.com`);
  const { contacts } = await seedBatch(t.pool, emails, { overrides: Object.fromEntries(emails.map((e) => [e, { status: "scheduled" }])) });
  for (const [i, ct] of contacts.entries()) {
    await addMessage(t.pool, ct.id, { state: "scheduled", scheduledFor: new Date(Date.now() + (i + 1) * H) });
    await t.pool.query("insert into events(contact_id, type, meta) values ($1,'x','{}'),($1,'y','{}')", [ct.id]);
  }
  const r = (await c.get("/api/dashboard")).json;
  assert.equal(r.upcoming.length, 10);
  assert.ok(new Date(r.upcoming[0].scheduledFor) <= new Date(r.upcoming[9].scheduledFor));
  assert.equal(r.recentEvents.length, 20);
});

test("POST /sweep in dry-run without a checker reports skipped", async () => {
  const r = await c.post("/api/sweep", {});
  assert.equal(r.status, 200);
  assert.equal(r.json.skipped, true);
});

test("POST /sweep with an injected checker marks replies", async () => {
  const s = await startTestApp({}, { appOptions: { checkReply: async (_cfg, id) => id === "<hit@x>" } });
  try {
    await s.addUser("admin");
    const sc = s.client();
    await sc.login();
    const { contacts } = await seedBatch(s.pool, ["hit@d.example.com", "miss@d.example.com"], {
      overrides: { "hit@d.example.com": { status: "sent" }, "miss@d.example.com": { status: "sent" } },
    });
    await addMessage(s.pool, contacts[0].id, { state: "sent", messageId: "<hit@x>", sentAt: new Date() });
    await addMessage(s.pool, contacts[1].id, { state: "sent", messageId: "<miss@x>", sentAt: new Date() });
    const r = await sc.post("/api/sweep", {});
    assert.equal(r.status, 200);
    assert.equal(r.json.replied, 1);
    const st = await s.pool.query("select email, status from contacts order by email");
    assert.deepEqual(st.rows.map((x) => x.status), ["replied", "sent"]);
  } finally {
    await s.close();
  }
});
