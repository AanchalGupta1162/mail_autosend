import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { runSweep } from "../../src/worker/sweep.js";
import { buildReplySearches } from "../../src/imap.js";
import { createPoller, intervalGate } from "../../src/worker/poller.js";

let db, pool;
before(async () => {
  db = await createTestDb();
  pool = db.pool;
});
after(async () => db?.close());

const quiet = () => {
  const lines = [];
  return { lines, error: (...a) => lines.push(a.join(" ")), warn() {}, info() {} };
};
let n = 0;
const em = () => `s${++n}@example.com`;
const contactRow = async (id) => (await pool.query("select * from contacts where id=$1", [id])).rows[0];

async function sentContact(extra = {}) {
  const email = em();
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "sent", ...extra } } });
  const c = contacts[0];
  const msg = await addMessage(pool, c.id, { state: "sent", messageId: `<${c.id}@x>`, sentAt: new Date(Date.now() - 3600_000) });
  return { c, msg };
}

test("a reply marks the contact replied, cancels the pending follow-up and writes an event", async () => {
  const { c } = await sentContact({ followup_requested: true });
  const fu = await addMessage(pool, c.id, { kind: "followup", state: "scheduled", scheduledFor: new Date(Date.now() + 86_400_000) });
  const calls = [];
  const checkReply = async (_cfg, messageId, opts) => (calls.push({ messageId, opts }), messageId === `<${c.id}@x>`);
  const out = await runSweep({ pool, config: { dryRun: false }, checkReply, logger: quiet() });
  assert.equal(out.skipped, undefined);
  assert.ok(out.replied >= 1);
  const row = await contactRow(c.id);
  assert.equal(row.status, "replied");
  assert.ok(row.replied_at);
  assert.equal(row.followup_requested, false);
  assert.equal((await pool.query("select state from messages where id=$1", [fu.id])).rows[0].state, "cancelled");
  const ev = await pool.query("select meta from events where contact_id=$1 and type='replied'", [c.id]);
  assert.equal(ev.rowCount, 1);
  assert.equal(ev.rows[0].meta.source, "imap");
  const call = calls.find((x) => x.messageId === `<${c.id}@x>`);
  assert.equal(call.opts.fromEmail, c.email);
  assert.equal(call.opts.subject, c.subject);
  assert.ok(call.opts.since instanceof Date);
});

test("no reply leaves the contact untouched; running again does not duplicate events", async () => {
  const { c } = await sentContact();
  await runSweep({ pool, config: { dryRun: false }, checkReply: async () => false, logger: quiet() });
  assert.equal((await contactRow(c.id)).status, "sent");
  const yes = async (_cfg, id) => id === `<${c.id}@x>`;
  await runSweep({ pool, config: { dryRun: false }, checkReply: yes, logger: quiet() });
  await runSweep({ pool, config: { dryRun: false }, checkReply: yes, logger: quiet() });
  assert.equal((await pool.query("select 1 from events where contact_id=$1 and type='replied'", [c.id])).rowCount, 1);
});

test("an IMAP error leaves all state unchanged, is logged without message text, and is retried next sweep", async () => {
  const { c } = await sentContact();
  const logger = quiet();
  const boom = async () => {
    throw Object.assign(new Error("auth failed pass=hunter2"), { code: "EAUTH" });
  };
  const out = await runSweep({ pool, config: { dryRun: false }, checkReply: boom, logger });
  assert.equal(out.error, true);
  assert.equal((await contactRow(c.id)).status, "sent");
  assert.equal((await pool.query("select 1 from events where contact_id=$1", [c.id])).rowCount, 0);
  assert.match(logger.lines.join("\n"), /EAUTH/);
  assert.doesNotMatch(logger.lines.join("\n"), /hunter2/);
  const again = await runSweep({ pool, config: { dryRun: false }, checkReply: async (_c, id) => id === `<${c.id}@x>`, logger: quiet() });
  assert.equal(again.error, undefined);
  assert.equal((await contactRow(c.id)).status, "replied");
});

test("only sent contacts are checked: uploaded, replied and opted_out are ignored", async () => {
  const email = [em(), em(), em()];
  const { contacts } = await seedBatch(pool, email, {
    overrides: { [email[0]]: { status: "uploaded" }, [email[1]]: { status: "opted_out" }, [email[2]]: { status: "replied" } },
  });
  for (const c of contacts) await addMessage(pool, c.id, { state: "sent", messageId: `<${c.id}@x>`, sentAt: new Date() });
  const seen = [];
  await runSweep({ pool, config: { dryRun: false }, checkReply: async (_c, id) => (seen.push(id), true), logger: quiet() });
  for (const c of contacts) assert.ok(!seen.includes(`<${c.id}@x>`));
});

test("dry-run skips the sweep unless a checker is injected", async () => {
  const { c } = await sentContact();
  const out = await runSweep({ pool, config: { dryRun: true }, logger: quiet() });
  assert.equal(out.skipped, true);
  assert.equal((await contactRow(c.id)).status, "sent");
  const injected = await runSweep({ pool, config: { dryRun: true }, checkReply: async (_c, id) => id === `<${c.id}@x>`, logger: quiet() });
  assert.equal(injected.skipped, undefined);
  assert.equal((await contactRow(c.id)).status, "replied");
});

test("shouldStop ends the sweep early", async () => {
  await sentContact();
  let calls = 0;
  await runSweep({ pool, config: { dryRun: false }, checkReply: async () => (calls++, false), shouldStop: () => true, logger: quiet() });
  assert.equal(calls, 0);
});

test("reply matching covers rewritten Message-IDs: header searches plus a sender+subject+date fallback", () => {
  const since = new Date("2026-10-01T10:00:00Z");
  const qs = buildReplySearches("<abc@mail.gmail.com>", { fromEmail: "Jo@Example.com", subject: "Role at Acme", since });
  assert.deepEqual(qs[0], { header: { "in-reply-to": "<abc@mail.gmail.com>" } });
  assert.deepEqual(qs[1], { header: { references: "<abc@mail.gmail.com>" } });
  assert.deepEqual(qs[2], { from: "jo@example.com", subject: "Role at Acme", since });
  // Without contact details only the header searches remain.
  assert.equal(buildReplySearches("<a@b>").length, 2);
  // CR/LF in a subject must never reach the search.
  assert.equal(buildReplySearches("<a@b>", { fromEmail: "a@b.c", subject: "x\r\ny", since }).length, 2);
});

test("intervalGate runs the task only once per interval and on first call", async () => {
  let t = 1_000_000;
  let runs = 0;
  const gated = intervalGate(600_000, async () => void runs++, () => t);
  await gated();
  await gated();
  assert.equal(runs, 1);
  t += 599_000;
  await gated();
  assert.equal(runs, 1);
  t += 2_000;
  await gated();
  assert.equal(runs, 2);
});

test("poller still stops cleanly when the run combines tick and sweep", async () => {
  let done = 0;
  const gated = intervalGate(10, async () => { await new Promise((r) => setTimeout(r, 30)); done++; });
  const p = createPoller({ intervalMs: 5, logger: quiet(), run: async () => gated() });
  p.start();
  await new Promise((r) => setTimeout(r, 15));
  await p.stop();
  assert.ok(done >= 1);
});
