import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { runTick } from "../../src/worker/tick.js";
import { markReplied, optOut } from "../../src/domain/contacts.js";
import { syncFollowup } from "../../src/domain/schedule.js";
import { putTemplate } from "../../src/domain/template.js";
import { createMailer } from "../../src/mailer.js";

let db, pool;
before(async () => {
  db = await createTestDb();
  pool = db.pool;
});
after(async () => db?.close());
beforeEach(async () => {
  await pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
  await pool.query("UPDATE settings SET value = jsonb_build_object('subject','Re: {{subject}}','body', E'Hi {{firstName}},\\n\\nJust following up on my note about the {{role}} role at {{company}}. Happy to share anything that would help.\\n\\nBest,\\nHarshavardhan Khamkar') WHERE key='followup_template'");
});

const D = 86_400_000;
const baseConfig = {
  dryRun: false,
  dailySendCap: 100,
  maxPerTick: 5,
  sendGapSecondsMin: 15,
  sendGapSecondsMax: 45,
  gmailUser: "me@example.com",
  fromName: "Harsh",
};
const noSleep = async () => {};
const silent = { error() {}, warn() {}, info() {} };

function fakeMailer({ fail, delayMs = 0, onSend } = {}) {
  const calls = [];
  return {
    calls,
    async sendMail(opts) {
      calls.push(opts);
      if (onSend) await onSend(opts);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const f = typeof fail === "function" ? fail(opts, calls.length) : fail;
      if (f) throw f;
      return { messageId: opts.messageId };
    },
  };
}
const tick = (o = {}) =>
  runTick({ pool, mailer: o.mailer ?? fakeMailer(), config: { ...baseConfig, ...(o.config ?? {}) }, now: o.now ?? (() => new Date()), sleep: o.sleep ?? noSleep, logger: silent, ...(o.extra ?? {}) });

let n = 0;
const em = () => `w${++n}@example.com`;
// One contact that is scheduled with a due initial message.
async function dueInitial(overrides = {}, msg = {}) {
  const email = em();
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "scheduled", ...overrides } } });
  const m = await addMessage(pool, contacts[0].id, msg);
  return { contact: contacts[0], msg: m, email };
}
// A contact whose initial was already sent (status sent), ready for a follow-up.
async function sentContact(overrides = {}, initial = {}) {
  return dueInitial(
    { status: "sent", ...overrides },
    { state: "sent", sentAt: new Date(Date.now() - 10 * D), messageId: "<i@x>", scheduledFor: new Date(Date.now() - 10 * D), ...initial },
  );
}
const msgRow = async (id) => (await pool.query("select * from messages where id=$1", [id])).rows[0];
const contactRow = async (id) => (await pool.query("select * from contacts where id=$1", [id])).rows[0];

test("sends a due initial: Message-ID stored BEFORE the SMTP call and reused for it; contact becomes sent", async () => {
  const { contact, msg, email } = await dueInitial();
  let seenDuring;
  const mailer = fakeMailer({
    onSend: async (opts) => {
      seenDuring = await msgRow(msg.id);
      assert.equal(seenDuring.state, "sending");
      assert.equal(seenDuring.message_id, opts.messageId);
    },
  });
  const s = await tick({ mailer });
  assert.equal(s.sent, 1);
  assert.equal(mailer.calls.length, 1);
  assert.equal(mailer.calls[0].to, email);
  assert.match(mailer.calls[0].messageId, /^<[0-9a-f-]{36}@[^>]+>$/);
  const m = await msgRow(msg.id);
  assert.equal(m.state, "sent");
  assert.equal(m.message_id, mailer.calls[0].messageId);
  assert.equal(m.attempts, 1);
  assert.equal(m.dry_run, false);
  assert.ok(m.sent_at);
  assert.equal((await contactRow(contact.id)).status, "sent");
  assert.equal(Number((await pool.query("select count(*) n from events where type='sent' and contact_id=$1", [contact.id])).rows[0].n), 1);
});

test("only due scheduled messages are sent; injected clock decides", async () => {
  const future = await dueInitial({}, { scheduledFor: new Date(Date.now() + 3600_000) });
  const m = fakeMailer();
  assert.equal((await tick({ mailer: m })).sent, 0);
  assert.equal(m.calls.length, 0);
  assert.equal((await tick({ mailer: m, now: () => new Date(Date.now() + 2 * 3600_000) })).sent, 1);
  assert.equal((await msgRow(future.msg.id)).state, "sent");
});

test("resume attachment is included for initials when configured", async () => {
  await dueInitial();
  const m = fakeMailer();
  await tick({ mailer: m, config: { resumePath: "/tmp/resume.pdf" } });
  assert.deepEqual(m.calls[0].attachments, [{ path: "/tmp/resume.pdf" }]);
});

test("DRY_RUN with a real jsonTransport builds a real Message-ID, delivers nothing and sets dry_run", async () => {
  const { msg } = await dueInitial();
  const mailer = createMailer({ dryRun: true });
  const s = await tick({ mailer, config: { dryRun: true } });
  assert.equal(s.sent, 1);
  const m = await msgRow(msg.id);
  assert.equal(m.state, "sent");
  assert.equal(m.dry_run, true);
  assert.match(m.message_id, /^<.+@.+>$/);
  assert.equal(mailer.transporter?.name ?? mailer.name, "JSONTransport");
});

for (const [label, setup] of [
  ["replied", (c) => pool.query("update contacts set status='replied' where id=$1", [c.id])],
  ["opted_out", (c) => pool.query("update contacts set status='opted_out' where id=$1", [c.id])],
  ["bounced", (c) => pool.query("update contacts set status='bounced' where id=$1", [c.id])],
  ["failed", (c) => pool.query("update contacts set status='failed' where id=$1", [c.id])],
  ["suppressed", (c) => pool.query("insert into suppressions(email) values (lower($1))", [c.email])],
  ["same email replied in another batch", async (c) => { await seedBatch(pool, [c.email.toUpperCase()], { overrides: { [c.email.toUpperCase()]: { status: "replied" } } }); }],
]) {
  test(`(b) recheck: due message for a ${label} contact is cancelled with an error and never sent`, async () => {
    const { contact, msg } = await dueInitial();
    await setup(contact);
    const m = fakeMailer();
    const s = await tick({ mailer: m });
    assert.equal(m.calls.length, 0);
    assert.equal(s.sent, 0);
    assert.equal(s.cancelled, 1);
    const row = await msgRow(msg.id);
    assert.equal(row.state, "cancelled");
    assert.match(row.error, /./);
  });
}

test("(b) race: markReplied / optOut between claim and send leave the in-flight row alone, but the worker re-check stops the send", async () => {
  for (const act of [(id) => markReplied(pool, id), (id) => optOut(pool, id)]) {
    const { contact, msg } = await dueInitial();
    const m = fakeMailer();
    await tick({ mailer: m, extra: { onClaimed: async () => { await act(contact.id); } } });
    assert.equal(m.calls.length, 0);
    assert.equal((await msgRow(msg.id)).state, "cancelled");
  }
});

test("(b) race: a row taken over (needs_review) or cancelled after claim is not sent by this worker", async () => {
  const { msg } = await dueInitial();
  const m = fakeMailer();
  await tick({ mailer: m, extra: { onClaimed: async () => { await pool.query("update messages set state='needs_review' where id=$1", [msg.id]); } } });
  assert.equal(m.calls.length, 0);
  assert.equal((await msgRow(msg.id)).state, "needs_review");
});

test("(d) a sending row older than 10 minutes becomes needs_review and is never resent; a younger one is untouched", async () => {
  const old = await dueInitial({}, { state: "sending", claimedAt: new Date(Date.now() - 11 * 60_000), messageId: "<old@x>" });
  const young = await dueInitial({}, { state: "sending", claimedAt: new Date(Date.now() - 5 * 60_000), messageId: "<young@x>" });
  const m = fakeMailer();
  const s = await tick({ mailer: m });
  await tick({ mailer: m });
  assert.equal(s.staleRecovered, 1);
  assert.equal(m.calls.length, 0);
  assert.equal((await msgRow(old.msg.id)).state, "needs_review");
  assert.equal((await msgRow(young.msg.id)).state, "sending");
});

test("(d) retries only when nothing was sent: up to 3 attempts with backoff, then failed", async () => {
  const { contact, msg } = await dueInitial();
  const authErr = Object.assign(new Error("Invalid login"), { code: "EAUTH", command: "AUTH PLAIN", responseCode: 454 });
  const m = fakeMailer({ fail: authErr });
  let clock = Date.now();
  const now = () => new Date(clock);

  let s = await tick({ mailer: m, now });
  assert.equal(s.retried, 1);
  let row = await msgRow(msg.id);
  assert.equal(row.state, "scheduled");
  assert.equal(row.attempts, 1);
  assert.ok(row.scheduled_for.getTime() > clock, "backoff pushes scheduled_for into the future");
  assert.match(row.error, /EAUTH/);

  assert.equal((await tick({ mailer: m, now })).sent + m.calls.length - 1, 0, "not due again yet");
  clock += 60 * 60_000;
  await tick({ mailer: m, now });
  row = await msgRow(msg.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.state, "scheduled");
  clock += 60 * 60_000;
  s = await tick({ mailer: m, now });
  row = await msgRow(msg.id);
  assert.equal(row.attempts, 3);
  assert.equal(row.state, "failed");
  assert.equal(s.failed, 1);
  assert.equal(m.calls.length, 3);
  const c = await contactRow(contact.id);
  assert.equal(c.status, "failed");
  assert.match(c.error, /EAUTH/);
  clock += 24 * 60 * 60_000;
  await tick({ mailer: m, now });
  assert.equal(m.calls.length, 3, "never retried after failed");
});

test("(d) ambiguous failure after DATA goes to needs_review and is never retried or resent", async () => {
  const { contact, msg } = await dueInitial();
  const m = fakeMailer({ fail: Object.assign(new Error("socket closed"), { code: "ESOCKET", command: "DATA" }) });
  let clock = Date.now();
  const s = await tick({ mailer: m, now: () => new Date(clock) });
  assert.equal(s.needsReview, 1);
  const row = await msgRow(msg.id);
  assert.equal(row.state, "needs_review");
  assert.match(row.error, /ESOCKET/);
  clock += 7 * D;
  await tick({ mailer: m, now: () => new Date(clock) });
  assert.equal(m.calls.length, 1);
  assert.equal((await contactRow(contact.id)).status, "scheduled", "contact is not marked sent or failed when delivery is unknown");
});

test("a send that hangs past the timeout is ambiguous, not retried", async () => {
  const { msg } = await dueInitial();
  const m = fakeMailer({ delayMs: 200 });
  const s = await tick({ mailer: m, extra: { sendTimeoutMs: 20 } });
  assert.equal(s.needsReview, 1);
  assert.equal((await msgRow(msg.id)).state, "needs_review");
});

test("permanent recipient rejection fails immediately without retry", async () => {
  const { contact, msg } = await dueInitial();
  const m = fakeMailer({ fail: Object.assign(new Error("no such user"), { code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }) });
  await tick({ mailer: m });
  assert.equal((await msgRow(msg.id)).state, "failed");
  assert.equal((await contactRow(contact.id)).status, "failed");
  assert.equal(m.calls.length, 1);
});

test("(e) concurrent ticks never send the same message", async () => {
  const emails = Array.from({ length: 8 }, em);
  const { contacts } = await seedBatch(pool, emails, { overrides: Object.fromEntries(emails.map((e) => [e, { status: "scheduled" }])) });
  for (const c of contacts) await addMessage(pool, c.id);
  const m = fakeMailer({ delayMs: 15 });
  const results = await Promise.all([1, 2, 3].map(() => tick({ mailer: m, config: { maxPerTick: 4 } })));
  const to = m.calls.map((c) => c.to);
  assert.equal(new Set(to).size, to.length, "no recipient mailed twice");
  assert.equal(new Set(m.calls.map((c) => c.messageId)).size, m.calls.length);
  assert.equal(to.length, 8);
  assert.equal(results.reduce((a, r) => a + r.sent, 0), 8);
  const rows = (await pool.query("select state, attempts from messages")).rows;
  assert.ok(rows.every((r) => r.state === "sent" && r.attempts === 1));
});

test("(e) concurrent ticks with a large per-tick limit still send each of a few messages once", async () => {
  const emails = Array.from({ length: 3 }, em);
  const { contacts } = await seedBatch(pool, emails, { overrides: Object.fromEntries(emails.map((e) => [e, { status: "scheduled" }])) });
  for (const c of contacts) await addMessage(pool, c.id);
  const m = fakeMailer({ delayMs: 10 });
  await Promise.all([1, 2, 3, 4].map(() => tick({ mailer: m, config: { maxPerTick: 50 } })));
  assert.equal(m.calls.length, 3);
});

test("(f) MAX_PER_TICK limits a tick and the jitter gap goes through the injected sleep", async () => {
  const emails = Array.from({ length: 5 }, em);
  const { contacts } = await seedBatch(pool, emails, { overrides: Object.fromEntries(emails.map((e) => [e, { status: "scheduled" }])) });
  for (const c of contacts) await addMessage(pool, c.id);
  const sleeps = [];
  const m = fakeMailer();
  const s = await tick({ mailer: m, config: { maxPerTick: 3 }, sleep: async (ms) => void sleeps.push(ms), extra: { random: () => 0.5 } });
  assert.equal(s.sent, 3);
  assert.equal(sleeps.length, 2, "gap only between sends");
  assert.ok(sleeps.every((ms) => ms === 30_000), sleeps.join());
  const s2 = await tick({ mailer: m, config: { maxPerTick: 3 } });
  assert.equal(s2.sent, 2);
});

test("(f) DAILY_SEND_CAP is a rolling 24h count of real sends; dry-run sends have their own counter", async () => {
  const mk = async (state, sentAt, dryRun) => {
    const { contact } = await dueInitial({ status: "sent" }, { state, sentAt, dryRun, scheduledFor: new Date(Date.now() - 3 * D) });
    return contact;
  };
  await mk("sent", new Date(Date.now() - 3600_000), false); // counts (real)
  await mk("sent", new Date(Date.now() - 30 * 3600_000), false); // older than 24h: no
  await mk("sent", new Date(Date.now() - 3600_000), true); // dry-run: not counted against real cap
  for (let i = 0; i < 4; i++) await dueInitial();
  const m = fakeMailer();
  const s = await tick({ mailer: m, config: { dailySendCap: 3 } });
  assert.equal(s.sent, 2, "3 cap - 1 real send in last 24h");
  assert.equal((await tick({ mailer: m, config: { dailySendCap: 3 } })).sent, 0);
  assert.equal(m.calls.length, 2);

  // in dry-run mode only dry-run rows count: 1 dry-run in last 24h + the 0 new ones => cap 3 lets 2 more of the remaining 2 through
  const dm = fakeMailer();
  const sd = await tick({ mailer: dm, config: { dryRun: true, dailySendCap: 3 } });
  assert.equal(sd.sent, 2);
});

test("(f) DAILY_SEND_CAP=0 sends nothing; in-flight rows count against the cap", async () => {
  await dueInitial();
  const m = fakeMailer();
  assert.equal((await tick({ mailer: m, config: { dailySendCap: 0 } })).sent, 0);
  await dueInitial({}, { state: "sending", claimedAt: new Date(), messageId: "<fl@x>" });
  assert.equal((await tick({ mailer: m, config: { dailySendCap: 1 } })).sent, 0);
  assert.equal(m.calls.length, 0);
});

test("follow-up requested before send: created right after the initial is sent, at sent_at + delay", async () => {
  const { contact, msg } = await dueInitial({ followup_requested: true, followup_delay_days: 5 });
  const nowDate = new Date();
  await tick({ now: () => nowDate });
  const fu = (await pool.query("select * from messages where contact_id=$1 and kind='followup'", [contact.id])).rows;
  assert.equal(fu.length, 1);
  assert.equal(fu[0].state, "scheduled");
  assert.equal(fu[0].scheduled_for.getTime(), nowDate.getTime() + 5 * D);
  assert.equal((await msgRow(msg.id)).sent_at.getTime(), nowDate.getTime());
  await tick({ now: () => nowDate }); // idempotent: nothing more is created
  assert.equal((await pool.query("select 1 from messages where contact_id=$1 and kind='followup'", [contact.id])).rowCount, 1);
});

test("no follow-up is created when it was not requested", async () => {
  const { contact } = await dueInitial();
  await tick();
  assert.equal((await pool.query("select 1 from messages where contact_id=$1 and kind='followup'", [contact.id])).rowCount, 0);
});

test("(c) reply landing while the initial is in flight: no follow-up survives", async () => {
  const { contact } = await dueInitial({ followup_requested: true, followup_delay_days: 1 });
  let pending;
  const m = fakeMailer({ onSend: async () => { pending = markReplied(pool, contact.id); await new Promise((r) => setTimeout(r, 30)); } });
  await tick({ mailer: m });
  await pending;
  const rows = (await pool.query("select kind, state from messages where contact_id=$1 order by kind", [contact.id])).rows;
  assert.deepEqual(rows.filter((r) => r.kind === "followup").map((r) => r.state).filter((s) => s !== "cancelled"), []);
  const c = await contactRow(contact.id);
  assert.equal(c.status, "replied");
  assert.equal(c.followup_requested, false);
});

test("(c) a due follow-up is not sent when the checkbox was unticked, nor for replied/opted-out/suppressed contacts", async () => {
  for (const [label, prep] of [
    ["unticked", (c) => pool.query("update contacts set followup_requested=false where id=$1", [c.id])],
    ["replied", (c) => pool.query("update contacts set status='replied' where id=$1", [c.id])],
    ["opted_out", (c) => pool.query("update contacts set status='opted_out' where id=$1", [c.id])],
    ["suppressed", (c) => pool.query("insert into suppressions(email) values (lower($1))", [c.email])],
  ]) {
    const { contact } = await sentContact({ followup_requested: true });
    const f = await addMessage(pool, contact.id, { kind: "followup" });
    await prep(contact);
    const m = fakeMailer();
    await tick({ mailer: m });
    assert.equal(m.calls.length, 0, label);
    assert.equal((await msgRow(f.id)).state, "cancelled", label);
  }
});

test("unticking via the API path cancels the pending follow-up so the worker never sends it", async () => {
  const { contact } = await sentContact({ followup_requested: true });
  const f = await addMessage(pool, contact.id, { kind: "followup" });
  await syncFollowup(pool, contact.id, { enabled: false });
  const m = fakeMailer();
  await tick({ mailer: m });
  assert.equal(m.calls.length, 0);
  assert.equal((await msgRow(f.id)).state, "cancelled");
});

test("(g) follow-up is threaded on the initial's stored Message-ID, uses Re: subject and the rendered template; values are escaped", async () => {
  const { contact } = await dueInitial(
    { status: "sent", followup_requested: true, company: "<b>Acme</b> & Co", role: "{{company}}", person: "Priya Nair", subject: "Hello there" },
    { state: "sent", sentAt: new Date(Date.now() - 8 * D), messageId: "<initial-123@mail.example>", scheduledFor: new Date(Date.now() - 8 * D) },
  );
  await addMessage(pool, contact.id, { kind: "followup" });
  const m = fakeMailer();
  await tick({ mailer: m });
  assert.equal(m.calls.length, 1);
  const o = m.calls[0];
  assert.equal(o.subject, "Re: Hello there");
  assert.equal(o.inReplyTo, "<initial-123@mail.example>");
  assert.equal(o.references, "<initial-123@mail.example>");
  assert.notEqual(o.messageId, "<initial-123@mail.example>");
  assert.match(o.text, /^Hi Priya,/);
  assert.match(o.text, /the \{\{company\}\} role at <b>Acme<\/b> & Co\./);
  assert.match(o.html, /&lt;b&gt;Acme&lt;\/b&gt; &amp; Co/);
  assert.doesNotMatch(o.html, /<b>Acme/);
  const row = (await pool.query("select * from messages where contact_id=$1 and kind='followup'", [contact.id])).rows[0];
  assert.equal(row.state, "sent");
  assert.equal(row.message_id, o.messageId);
});

test("(g) contact Follow-up Text replaces the template body; edited template is used", async () => {
  const a = await sentContact({ followup_requested: true, followup_text: "Custom nudge for **you**." });
  await addMessage(pool, a.contact.id, { kind: "followup" });
  await tick({ mailer: (a.m = fakeMailer()) });
  assert.equal(a.m.calls[0].text, "Custom nudge for you.");

  await putTemplate(pool, { subject: "Re: {{subject}}", body: "Ping {{firstName}} at {{company}}" });
  const b = await sentContact({ followup_requested: true });
  await addMessage(pool, b.contact.id, { kind: "followup" });
  await tick({ mailer: (b.m = fakeMailer()) });
  assert.equal(b.m.calls[0].text, "Ping Jo at Acme");
});

test("a follow-up whose initial Message-ID is unknown is cancelled, not sent unthreaded", async () => {
  const { contact } = await dueInitial({ status: "sent", followup_requested: true });
  const f = await addMessage(pool, contact.id, { kind: "followup" });
  const m = fakeMailer();
  await tick({ mailer: m });
  assert.equal(m.calls.length, 0);
  assert.equal((await msgRow(f.id)).state, "cancelled");
});

test("a failed follow-up leaves the contact 'sent' and is recorded", async () => {
  const { contact } = await dueInitial({ status: "sent", followup_requested: true }, { state: "sent", sentAt: new Date(Date.now() - 8 * D), messageId: "<z@x>", scheduledFor: new Date(Date.now() - 8 * D) });
  const f = await addMessage(pool, contact.id, { kind: "followup" });
  const m = fakeMailer({ fail: Object.assign(new Error("no such user"), { code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }) });
  await tick({ mailer: m });
  assert.equal((await msgRow(f.id)).state, "failed");
  assert.equal((await contactRow(contact.id)).status, "sent");
});

test("a tick with nothing due is a no-op summary", async () => {
  const s = await tick();
  assert.deepEqual(s, { staleRecovered: 0, claimed: 0, sent: 0, cancelled: 0, retried: 0, failed: 0, needsReview: 0 });
});
