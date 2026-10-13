import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { runSweep } from "../../src/worker/sweep.js";
import { buildReplySearches, classifyReply, parseHeaders, createCheckerFromClient } from "../../src/imap.js";
import { followupSendsAllowed, SWEEP_WINDOW_DAYS, sweepTolerance, isFatalSweepError } from "../../src/worker/sweep.js";
import { stopWorkers } from "../../src/worker/poller.js";

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
  assert.deepEqual(qs[0], { via: "in-reply-to", query: { header: { "in-reply-to": "<abc@mail.gmail.com>" } } });
  assert.deepEqual(qs[1], { via: "references", query: { header: { references: "<abc@mail.gmail.com>" } } });
  assert.deepEqual(qs[2], { via: "from-subject", query: { from: "jo@example.com", subject: "Role at Acme", since } });
  assert.equal(buildReplySearches("<a@b>").length, 2);
  assert.equal(buildReplySearches("<a@b>", { fromEmail: "a@b.c", subject: "x\r\ny", since }).length, 2);
});

const H = (o) => parseHeaders(Object.entries(o).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
const ctx = { contactEmail: "ann@example.com", ownEmail: "me@gmail.com" };
const good = { from: "ann@example.com", subject: "Re: Role at Acme", headers: H({}) };

test("classifyReply accepts a human reply and rejects auto-replies, bounces and own mail", () => {
  assert.equal(classifyReply(good, ctx).ok, true);
  assert.equal(classifyReply({ ...good, headers: H({ "Auto-Submitted": "no" }) }, ctx).ok, true);
  for (const [name, m] of Object.entries({
    autoSubmitted: { ...good, headers: H({ "Auto-Submitted": "auto-replied" }) },
    autoGenerated: { ...good, headers: H({ "Auto-Submitted": "auto-generated" }) },
    xAutoreply: { ...good, headers: H({ "X-Autoreply": "yes" }) },
    xAutorespond: { ...good, headers: H({ "X-Autorespond": "1" }) },
    precAuto: { ...good, headers: H({ Precedence: "auto_reply" }) },
    precBulk: { ...good, headers: H({ Precedence: "Bulk" }) },
    precJunk: { ...good, headers: H({ Precedence: "junk" }) },
    daemon: { ...good, from: "MAILER-DAEMON@googlemail.com" },
    postmaster: { ...good, from: "postmaster@example.com" },
    own: { ...good, from: "Me@Gmail.com" },
    noFrom: { ...good, from: undefined },
    ooo: { ...good, subject: "Out of Office: Role at Acme" },
    autoSubj: { ...good, subject: "Automatic reply: Role at Acme" },
    reOoo: { ...good, subject: "Re: out of office" },
  })) {
    assert.equal(classifyReply(m, ctx).ok, false, name);
  }
});

test("classifyReply with exactFrom requires the sender to equal the contact (joann@ is not ann@)", () => {
  assert.equal(classifyReply({ ...good, from: "joann@example.com" }, { ...ctx, exactFrom: true }).ok, false);
  assert.equal(classifyReply({ ...good, from: "Ann@Example.com" }, { ...ctx, exactFrom: true }).ok, true);
  assert.equal(classifyReply({ ...good, from: "other@example.com" }, ctx).ok, true, "header matches do not need an exact sender");
});

test("event meta records the matched UID and which search matched", async () => {
  const { c } = await sentContact();
  const checkReply = async (_cfg, id) => (id === `<${c.id}@x>` ? { matched: true, via: "references", uid: 4242 } : false);
  await runSweep({ pool, config: { dryRun: false }, checkReply, logger: quiet() });
  const ev = await pool.query("select meta from events where contact_id=$1 and type='replied'", [c.id]);
  assert.equal(ev.rows[0].meta.source, "imap");
  assert.equal(ev.rows[0].meta.uid, 4242);
  assert.equal(ev.rows[0].meta.via, "references");
});

test("a per-row error is logged with the contact id and skipped; later contacts are still checked", async () => {
  const a = await sentContact();
  const b = await sentContact();
  const logger = quiet();
  const checkReply = async (_cfg, id) => {
    if (id === `<${a.c.id}@x>`) throw Object.assign(new Error("body text secret-xyz"), { code: "EPARSE" });
    return id === `<${b.c.id}@x>`;
  };
  const out = await runSweep({ pool, config: { dryRun: false }, checkReply, logger });
  assert.equal(out.error, undefined);
  assert.ok(out.rowErrors >= 1);
  assert.equal((await contactRow(a.c.id)).status, "sent");
  assert.equal((await contactRow(b.c.id)).status, "replied");
  const text = logger.lines.join("\n");
  assert.match(text, new RegExp(a.c.id));
  assert.match(text, /stage=check/);
  assert.doesNotMatch(text, /secret-xyz/);
});

test("a connection/auth error aborts; the next sweep starts with the contacts not yet checked (no starvation)", async () => {
  await pool.query("TRUNCATE batches CASCADE");
  const first = await sentContact();
  const second = await sentContact();
  await pool.query("update messages set sent_at = now() - interval '2 hours' where contact_id=$1", [first.c.id]);
  await pool.query("update messages set sent_at = now() - interval '1 hour' where contact_id=$1", [second.c.id]);
  const order1 = [];
  await runSweep({
    pool, config: { dryRun: false }, logger: quiet(),
    checkReply: async (_c, id) => { order1.push(id); if (order1.length === 2) throw Object.assign(new Error("x"), { code: "ECONNRESET" }); return false; },
  });
  assert.deepEqual(order1, [`<${first.c.id}@x>`, `<${second.c.id}@x>`]);
  const order2 = [];
  await runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async (_c, id) => (order2.push(id), false) });
  assert.equal(order2[0], `<${second.c.id}@x>`, "the contact whose check never completed goes first");
});

test("only initials sent within the window are swept", async () => {
  const { c } = await sentContact();
  await pool.query("update messages set sent_at = now() - ($2 || ' days')::interval where contact_id=$1", [c.id, String(SWEEP_WINDOW_DAYS + 5)]);
  const seen = [];
  await runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async (_c, id) => (seen.push(id), false) });
  assert.ok(!seen.includes(`<${c.id}@x>`));
});

test("one checker (one IMAP connection) serves the whole sweep and is closed", async () => {
  await sentContact();
  await sentContact();
  let opened = 0, closed = 0, checks = 0;
  const openChecker = async () => (opened++, { check: async () => (checks++, false), close: async () => void closed++ });
  await runSweep({ pool, config: { dryRun: false }, logger: quiet(), openChecker });
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.ok(checks >= 2);
});

test("a failure to connect is fatal, recorded, and leaves state unchanged", async () => {
  const { c } = await sentContact();
  const openChecker = async () => { throw Object.assign(new Error("nope"), { code: "EAUTH", fatal: true }); };
  const out = await runSweep({ pool, config: { dryRun: false }, logger: quiet(), openChecker });
  assert.equal(out.error, true);
  assert.equal((await contactRow(c.id)).status, "sent");
  const st = (await pool.query("select value from settings where key='sweep_state'")).rows[0].value;
  assert.equal(st.ok, false);
  assert.equal(st.errorCode, "EAUTH");
});

test("sweep state is recorded; lastSuccessAt survives a later failure", async () => {
  await pool.query("delete from settings where key='sweep_state'");
  await runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async () => false });
  let st = (await pool.query("select value from settings where key='sweep_state'")).rows[0].value;
  assert.equal(st.ok, true);
  assert.ok(st.lastSuccessAt && st.at);
  const okAt = st.lastSuccessAt;
  await sentContact();
  await runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); } });
  st = (await pool.query("select value from settings where key='sweep_state'")).rows[0].value;
  assert.equal(st.ok, false);
  assert.equal(st.errorCode, "ETIMEDOUT");
  assert.equal(st.lastSuccessAt, okAt);
});

test("overlapping sweeps are impossible: the second one is skipped as in_progress", async () => {
  await sentContact();
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async () => (await gate, false) });
  await new Promise((r) => setTimeout(r, 50));
  const second = await runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async () => false });
  assert.deepEqual(second, { skipped: true, reason: "in_progress" });
  release();
  await slow;
  const third = await runSweep({ pool, config: { dryRun: false }, logger: quiet(), checkReply: async () => false });
  assert.equal(third.skipped, undefined);
});

test("follow-up sends are held when the last successful sweep is older than 1 hour (real mode, sweep enabled)", async () => {
  const cfg = { dryRun: false, replySweepEnabled: true };
  const now = new Date();
  const set = (v) => pool.query("insert into settings(key,value) values('sweep_state',$1) on conflict (key) do update set value=excluded.value", [JSON.stringify(v)]);
  await pool.query("delete from settings where key='sweep_state'");
  assert.equal(await followupSendsAllowed(pool, cfg, now), false, "never swept");
  await set({ ok: true, lastSuccessAt: new Date(now.getTime() - 2 * 3600_000).toISOString() });
  assert.equal(await followupSendsAllowed(pool, cfg, now), false, "stale");
  await set({ ok: false, lastSuccessAt: new Date(now.getTime() - 600_000).toISOString() });
  assert.equal(await followupSendsAllowed(pool, cfg, now), true, "recent success");
  assert.equal(await followupSendsAllowed(pool, { ...cfg, dryRun: true }, now), true, "dry-run never held");
  assert.equal(await followupSendsAllowed(pool, { ...cfg, replySweepEnabled: false }, now), true, "sweep disabled");
});

// --- C1: imapflow never throws from search()/fetchOne(); it returns false/undefined ----------------
const fakeClient = (o = {}) => ({
  usable: true,
  mailbox: { path: "INBOX" },
  search: async () => [],
  fetchOne: async () => undefined,
  ...o,
});
const OPTS = { fromEmail: "ann@example.com", subject: "S", since: new Date() };
const goodMsg = { envelope: { from: [{ address: "ann@example.com" }], subject: "Re: S" }, headers: Buffer.from("") };

test("IMAP checker: an empty array is a real 'no reply'; a match returns uid and via", async () => {
  assert.equal(await createCheckerFromClient(fakeClient(), { gmailUser: "me@gmail.com" }).check("<a@b>", OPTS), false);
  const hit = createCheckerFromClient(fakeClient({ search: async () => [7], fetchOne: async () => goodMsg }), { gmailUser: "me@gmail.com" });
  assert.deepEqual(await hit.check("<a@b>", OPTS), { matched: true, via: "in-reply-to", uid: 7 });
});

test("IMAP checker: search() returning false/undefined is an error, never 'no reply'", async () => {
  for (const bad of [false, undefined, null]) {
    const ck = createCheckerFromClient(fakeClient({ search: async () => bad }), { gmailUser: "me@gmail.com" });
    await assert.rejects(ck.check("<a@b>", OPTS), (e) => e.code === "ESEARCH" && !isFatalSweepError(e), String(bad));
  }
});

test("IMAP checker: a closed connection / unselected mailbox is a FATAL error", async () => {
  for (const c of [fakeClient({ usable: false }), fakeClient({ mailbox: false }), fakeClient({ mailbox: undefined })]) {
    const ck = createCheckerFromClient(c, { gmailUser: "me@gmail.com" });
    await assert.rejects(ck.check("<a@b>", OPTS), (e) => isFatalSweepError(e));
  }
  // The connection dies during the search: it returns false and the mailbox is gone afterwards.
  const c = fakeClient();
  c.search = async () => { c.mailbox = false; return false; };
  await assert.rejects(createCheckerFromClient(c, { gmailUser: "me@gmail.com" }).check("<a@b>", OPTS), (e) => isFatalSweepError(e));
});

test("IMAP checker: a falsy fetchOne() result is an error, not a non-match", async () => {
  for (const bad of [undefined, false, null]) {
    const ck = createCheckerFromClient(fakeClient({ search: async () => [9], fetchOne: async () => bad }), { gmailUser: "me@gmail.com" });
    await assert.rejects(ck.check("<a@b>", OPTS), (e) => e.code === "EFETCH" && !isFatalSweepError(e), String(bad));
  }
  const gone = fakeClient({ search: async () => [9] });
  gone.fetchOne = async () => { gone.usable = false; return undefined; };
  await assert.rejects(createCheckerFromClient(gone, { gmailUser: "me@gmail.com" }).check("<a@b>", OPTS), (e) => isFatalSweepError(e));
});

test("sweep with a checker whose search returns false does not mark ok and never releases the follow-up hold", async () => {
  await pool.query("delete from settings where key='sweep_state'");
  const { c } = await sentContact();
  const openChecker = async () => createCheckerFromClient(fakeClient({ search: async () => false }), { gmailUser: "me@gmail.com" });
  const out = await runSweep({ pool, config: { dryRun: false, replySweepEnabled: true }, openChecker, logger: quiet() });
  assert.ok(out.rowErrors >= 1 || out.error);
  assert.equal((await contactRow(c.id)).status, "sent");
  // one failing row among few candidates is within tolerance, so make every row fail beyond it
  for (let i = 0; i < 4; i++) await sentContact();
  await runSweep({ pool, config: { dryRun: false, replySweepEnabled: true }, openChecker, logger: quiet() });
  assert.equal(await followupSendsAllowed(pool, { dryRun: false, replySweepEnabled: true }), false);
});

// --- I-new-2: tolerance ------------------------------------------------------------------------
test("sweepTolerance is max(3, 5% of candidates)", () => {
  assert.equal(sweepTolerance(0), 3);
  assert.equal(sweepTolerance(10), 3);
  assert.equal(sweepTolerance(60), 3);
  assert.equal(sweepTolerance(100), 5);
  assert.equal(sweepTolerance(400), 20);
});

test("a sweep with rowErrors <= tolerance still counts as successful; above it does not", async () => {
  await pool.query("TRUNCATE batches CASCADE");
  await pool.query("delete from settings where key='sweep_state'");
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(await sentContact());
  const failing = (n) => {
    const bad = new Set(rows.slice(0, n).map((r) => `<${r.c.id}@x>`));
    return async (_cfg, id) => {
      if (bad.has(id)) throw Object.assign(new Error("x"), { code: "EPARSE" });
      return false;
    };
  };
  const stateOf = async () => (await pool.query("select value from settings where key='sweep_state'")).rows[0].value;
  const ok = await runSweep({ pool, config: { dryRun: false }, checkReply: failing(3), logger: quiet() });
  assert.equal(ok.rowErrors, 3);
  let st = await stateOf();
  assert.equal(st.ok, true);
  assert.equal(st.rowErrors, 3);
  const firstSuccess = st.lastSuccessAt;
  await new Promise((r) => setTimeout(r, 20));
  const bad = await runSweep({ pool, config: { dryRun: false }, checkReply: failing(4), logger: quiet() });
  assert.equal(bad.rowErrors, 4);
  st = await stateOf();
  assert.equal(st.ok, false);
  assert.equal(st.rowErrors, 4);
  assert.equal(st.lastSuccessAt, firstSuccess, "lastSuccessAt does not advance");
});

// --- minor: markReplied failures ----------------------------------------------------------------
test("an unexpected markReplied failure counts as a row error; an expected 409 (opted out meanwhile) does not", async () => {
  await pool.query("TRUNCATE batches CASCADE");
  const unexpected = await sentContact();
  const brokenPool = { query: pool.query.bind(pool), connect: async () => { throw new Error("db down"); } };
  const logger = quiet();
  const out = await runSweep({ pool: brokenPool, config: { dryRun: false }, logger, checkReply: async (_c, id) => id === `<${unexpected.c.id}@x>` });
  assert.equal(out.rowErrors, 1);
  assert.match(logger.lines.join("\n"), /stage=mark/);
  assert.doesNotMatch(logger.lines.join("\n"), /db down/);

  await pool.query("TRUNCATE batches CASCADE");
  const expected = await sentContact();
  const out2 = await runSweep({
    pool, config: { dryRun: false }, logger: quiet(),
    checkReply: async (_c, id) => {
      if (id !== `<${expected.c.id}@x>`) return false;
      await pool.query("update contacts set status='opted_out' where id=$1", [expected.c.id]);
      return true;
    },
  });
  assert.equal(out2.rowErrors, 0);
  assert.equal(out2.replied, 0);
});

// --- I-new-1: shutdown order --------------------------------------------------------------------
test("stopWorkers stops the send poller first and does not wait for the sweep before stopping it", async () => {
  const log = [];
  let releaseSend;
  const send = { stop: () => (log.push("send:stop"), new Promise((r) => (releaseSend = () => (log.push("send:done"), r())))) };
  const sweep = { stop: async () => void log.push("sweep:stop") };
  const p = stopWorkers(send, sweep);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(log, ["send:stop", "sweep:stop"], "both stopped immediately, send first, while the send is still in flight");
  releaseSend();
  await p;
  await stopWorkers(null, undefined); // tolerates missing pollers
});
