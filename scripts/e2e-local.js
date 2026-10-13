// Local end-to-end run, no real mail: login -> upload test/fixtures/sample.csv -> schedule one
// minute ahead -> tick (injected clock) -> follow-up tick (threading headers) -> a simulated
// reply cancels a pending follow-up. Everything happens in a throwaway schema t_<random> of
// DATABASE_URL (never `public`), dropped at the end. DRY_RUN is forced on: nodemailer's
// jsonTransport builds the real message and Message-ID but delivers nothing.
//
//   npm run e2e:local
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createTestDb } from "../test/helpers/db.js";
import { Client } from "../test/helpers/app.js";
import { createApp } from "../src/server/app.js";
import { loadServerConfig } from "../src/server/env.js";
import { createMailer } from "../src/mailer.js";
import { hashPassword } from "../src/auth/password.js";
import { runTick } from "../src/worker/tick.js";

const PASSWORD = `e2e-${randomBytes(9).toString("hex")}`;
const MIN = 60_000;
const DAY = 86_400_000;
const log = (m) => console.log(m);
const step = (n, m) => log(`\n[${n}] ${m}`);
const ok = (m) => log(`    ok  ${m}`);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required (it is only used to create a throwaway schema).");
  process.exit(1);
}

const db = await createTestDb();
log(`throwaway schema: ${db.schema} (dropped at the end; public is never touched)`);
let server;
try {
  const config = loadServerConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: randomBytes(24).toString("hex"),
    NODE_ENV: "development",
    DRY_RUN: "true", // forced, whatever the environment says
    MAX_PER_TICK: "5",
    SEND_GAP_SECONDS_MIN: "0",
    SEND_GAP_SECONDS_MAX: "0",
    FROM_NAME: "E2E Sender",
    GMAIL_USER: "e2e.sender@example.com",
  });
  assert.equal(config.dryRun, true);

  // The jsonTransport mailer, wrapped to keep what the worker handed to nodemailer plus the
  // message nodemailer built from it.
  const transport = createMailer(config);
  const sent = [];
  const mailer = {
    async sendMail(options) {
      const info = await transport.sendMail(options);
      sent.push({ options, built: JSON.parse(info.message) });
      return info;
    },
  };

  // Simulated inbox: a reply exists for the Message-IDs in this set.
  const repliedTo = new Set();
  const app = createApp({
    pool: db.pool,
    config,
    mailer,
    checkReply: async (_cfg, messageId) => repliedTo.has(messageId),
    logger: { error() {}, warn() {}, info() {} },
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const client = new Client(`http://127.0.0.1:${server.address().port}`);
  await db.pool.query("INSERT INTO users(username, password_hash) VALUES ('e2e', $1)", [await hashPassword(PASSWORD)]);

  const tick = (at) => runTick({ pool: db.pool, mailer, config, now: () => new Date(at), sleep: async () => {}, logger: console });

  step(1, "login");
  assert.equal((await client.get("/api/auth/me")).status, 401);
  assert.equal((await client.login("e2e", PASSWORD)).status, 200);
  assert.equal((await client.get("/api/auth/me")).status, 200);
  ok("anonymous /me is 401; after login it is 200");

  step(2, "upload test/fixtures/sample.csv (nothing is scheduled by uploading)");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(new URL("../test/fixtures/sample.csv", import.meta.url))], { type: "text/csv" }), "sample.csv");
  const up = await client.raw("POST", "/api/batches", { rawBody: form });
  assert.equal(up.status, 201, up.text);
  const { batch, contacts } = up.json;
  assert.ok(contacts.length >= 2, "fixture has at least two contacts");
  assert.ok(contacts.every((c) => c.status === "uploaded"));
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM messages")).rows[0].n, 0);
  ok(`${contacts.length} contacts imported, ${up.json.errors.length} rejected rows, 0 messages`);

  const [a, b] = contacts; // a: gets the follow-up; b: replies before its follow-up is due
  const t0 = Date.now();

  step(3, "schedule both one minute ahead, follow-up after 1 day");
  const sendAt = new Date(t0 + MIN).toISOString();
  const sch = await client.post(`/api/batches/${batch.id}/schedule`, { contactIds: [a.id, b.id], sendAt });
  assert.equal(sch.status, 201, sch.text);
  for (const c of [a, b]) {
    const fu = await client.raw("PUT", `/api/contacts/${c.id}/followup`, { body: { enabled: true, delayDays: 1 } });
    assert.equal(fu.status, 200, fu.text);
  }
  ok(`scheduled for ${sendAt}; follow-up requested on both`);

  step(4, "tick before it is due (clock = t0 + 30s): nothing is sent");
  let s = await tick(t0 + 30_000);
  assert.equal(s.sent, 0);
  assert.equal(sent.length, 0);
  ok("sent=0");

  step(5, "tick when due (clock = t0 + 2min): both initials go out (dry-run transport)");
  const t1 = t0 + 2 * MIN;
  s = await tick(t1);
  assert.equal(s.sent, 2, JSON.stringify(s));
  assert.equal(sent.length, 2);
  const rows = (await db.pool.query("SELECT m.*, c.email, c.status AS cstatus FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.kind = 'initial' ORDER BY m.scheduled_for, m.created_at")).rows;
  assert.ok(rows.every((r) => r.state === "sent" && r.dry_run === true && r.cstatus === "sent" && /^<[^<>@\s]+@[^<>\s]+>$/.test(r.message_id)));
  for (const m of sent) assert.equal(m.built.messageId, m.options.messageId, "the stored Message-ID is the one nodemailer used");
  ok(`2 sent, dry_run=true, contacts now 'sent', Message-IDs ${rows.map((r) => r.message_id).join(" ")}`);
  const followups = (await db.pool.query("SELECT * FROM messages WHERE kind = 'followup' ORDER BY created_at")).rows;
  assert.equal(followups.length, 2);
  assert.ok(followups.every((f) => f.state === "scheduled" && Math.abs(new Date(f.scheduled_for) - (t1 + DAY)) < 5_000));
  ok("2 follow-ups scheduled at sent_at + 1 day");

  step(6, "simulate a reply from contact B, then POST /api/sweep");
  const bInitial = rows.find((r) => r.contact_id === b.id);
  repliedTo.add(bInitial.message_id);
  const sw = await client.post("/api/sweep", {});
  assert.equal(sw.status, 200, sw.text);
  assert.equal(sw.json.replied, 1, JSON.stringify(sw.json));
  const bAfter = (await db.pool.query("SELECT status FROM contacts WHERE id = $1", [b.id])).rows[0];
  const bFollowup = (await db.pool.query("SELECT state FROM messages WHERE contact_id = $1 AND kind = 'followup'", [b.id])).rows[0];
  assert.equal(bAfter.status, "replied");
  assert.equal(bFollowup.state, "cancelled");
  ok("B is 'replied' and its pending follow-up is 'cancelled'");

  step(7, "tick when the follow-up is due (clock = t1 + 1 day + 1min): only A's follow-up goes out, threaded");
  const before = sent.length;
  s = await tick(t1 + DAY + MIN);
  assert.equal(s.sent, 1, JSON.stringify(s));
  assert.equal(sent.length, before + 1);
  const f = sent.at(-1);
  const aInitial = rows.find((r) => r.contact_id === a.id);
  assert.equal(f.options.to, a.email);
  assert.equal(f.options.inReplyTo, aInitial.message_id);
  assert.equal(f.options.references, aInitial.message_id);
  assert.match(f.built.subject, /^Re: /);
  assert.equal(f.built.subject.match(/Re:/gi).length, 1);
  assert.equal(f.built.inReplyTo, aInitial.message_id);
  assert.equal(f.built.references, aInitial.message_id);
  assert.notEqual(f.built.messageId, aInitial.message_id);
  assert.ok(!sent.some((m) => m.options.to === b.email && m.options.subject?.startsWith("Re:")), "nothing went to the contact who replied");
  ok(`To=${f.options.to}  Subject="${f.built.subject}"`);
  ok(`In-Reply-To=${f.built.inReplyTo}  References=${f.built.references}  own Message-ID=${f.built.messageId}`);

  step(8, "a further tick sends nothing more");
  s = await tick(t1 + 3 * DAY);
  assert.equal(s.sent, 0);
  assert.equal(sent.length, 3);
  ok("3 messages in total: 2 initials + 1 follow-up; none delivered anywhere (jsonTransport)");

  log("\nE2E OK");
} catch (err) {
  console.error("\nE2E FAILED:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  await db.close();
  log(`schema ${db.schema} dropped`);
}
