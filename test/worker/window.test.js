import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { runTick } from "../../src/worker/tick.js";
import { putSendWindow } from "../../src/domain/sendWindow.js";

let db, pool;
before(async () => {
  db = await createTestDb();
  pool = db.pool;
});
after(async () => db?.close());
beforeEach(async () => {
  await pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM settings WHERE key IN ('send_hold','send_window')");
});

const baseConfig = {
  dryRun: false,
  resumePath: path.resolve("test/fixtures/resume.pdf"),
  dailySendCap: 100,
  maxPerTick: 5,
  sendGapSecondsMin: 0,
  sendGapSecondsMax: 0,
  gmailUser: "me@example.com",
  fromName: "Harsh",
  sendWindowEnforced: true,
};
const silent = { error() {}, warn() {}, info() {} };
const INSIDE = new Date("2026-10-14T03:45:00Z"); // 09:15 IST
const OUTSIDE = new Date("2026-10-14T04:30:00Z"); // 10:00 IST (end is exclusive)
const LONG_AGO = new Date("2026-10-01T00:00:00Z");

function mailer(onSend) {
  const calls = [];
  return {
    calls,
    async sendMail(o) {
      calls.push(o);
      await onSend?.(o);
      return { messageId: o.messageId };
    },
  };
}
const tick = (o = {}) => runTick({ pool, mailer: o.mailer ?? mailer(), config: { ...baseConfig, ...(o.config ?? {}) }, now: o.now ?? (() => INSIDE), sleep: async () => {}, logger: silent });

let n = 0;
async function dueInitials(count) {
  const emails = Array.from({ length: count }, () => `win${++n}@example.com`);
  const { contacts } = await seedBatch(pool, emails, { overrides: Object.fromEntries(emails.map((e) => [e, { status: "scheduled" }])) });
  for (const c of contacts) await addMessage(pool, c.id, { scheduledFor: LONG_AGO });
  return contacts;
}

test("enforced: a real initial send is not claimed outside the window", async () => {
  await dueInitials(1);
  const m = mailer();
  const out = await tick({ mailer: m, now: () => OUTSIDE });
  assert.equal(out.claimed, 0);
  assert.equal(out.sent, 0);
  assert.equal(out.outsideWindow, true);
  assert.equal(m.calls.length, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM messages WHERE state='scheduled'")).rows[0].n, 1);
});

test("enforced: a real follow-up is not claimed outside the window either", async () => {
  const email = `win${++n}@example.com`;
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "sent", followup_requested: true } } });
  await addMessage(pool, contacts[0].id, { state: "sent", sentAt: LONG_AGO, messageId: "<i@x>" });
  await addMessage(pool, contacts[0].id, { kind: "followup", scheduledFor: LONG_AGO });
  const m = mailer();
  assert.equal((await tick({ mailer: m, now: () => OUTSIDE })).sent, 0);
  assert.equal(m.calls.length, 0);
  const inside = await tick({ mailer: m, now: () => INSIDE });
  assert.equal(inside.sent, 1, "same message goes out once the window is open");
  assert.equal(inside.outsideWindow, undefined);
});

test("enforced: inside the window (start inclusive) sends normally", async () => {
  await dueInitials(2);
  const out = await tick({ now: () => new Date("2026-10-14T03:30:00Z") }); // 09:00:00 IST
  assert.equal(out.sent, 2);
});

test("not enforced (default, local dev): sends at any hour", async () => {
  await dueInitials(1);
  const out = await tick({ config: { sendWindowEnforced: undefined }, now: () => OUTSIDE });
  assert.equal(out.sent, 1);
});

test("enforced but dry-run: never gated", async () => {
  await dueInitials(1);
  const out = await tick({ config: { dryRun: true }, now: () => OUTSIDE });
  assert.equal(out.sent, 1);
});

test("the stored send_window setting is honoured", async () => {
  await dueInitials(1);
  await putSendWindow(pool, { start: "10:00", end: "11:00", tz: "Asia/Kolkata" });
  assert.equal((await tick({ now: () => INSIDE })).sent, 0, "09:15 IST is now outside");
  assert.equal((await tick({ now: () => OUTSIDE })).sent, 1, "10:00 IST is now inside");
});

test("the window closing mid-tick stops further claims", async () => {
  await dueInitials(3);
  let clock = INSIDE;
  const m = mailer(() => {
    clock = OUTSIDE; // the first send takes us past 10:00
  });
  const out = await tick({ mailer: m, now: () => clock });
  assert.equal(out.sent, 1);
  assert.equal(out.outsideWindow, true);
  assert.equal((await pool.query("SELECT count(*)::int n FROM messages WHERE state='scheduled'")).rows[0].n, 2);
});
