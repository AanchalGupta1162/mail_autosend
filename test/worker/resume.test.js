import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { startFakeSmtp } from "../helpers/smtp.js";
import { runTick, HOLD_MINUTES } from "../../src/worker/tick.js";
import { createLocalStorage, ResumeStorageError } from "../../src/storage/resumes.js";
import { createResume } from "../../src/domain/resumes.js";

const SIGNATURE = path.resolve("test/fixtures/sig-fixture.html");
const LEGACY = path.resolve("test/fixtures/resume.pdf");
const silent = { error() {}, warn() {}, info() {} };
const baseConfig = {
  dryRun: false, dailySendCap: 100, maxPerTick: 5, sendGapSecondsMin: 0, sendGapSecondsMax: 0,
  gmailUser: "me@example.com", fromName: "Harsh", signaturePath: SIGNATURE,
};
const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% ${tag}\n${"0123456789".repeat(40)}\n%%EOF\n`);

let db, pool, smtp, dir, storage;
before(async () => {
  db = await createTestDb();
  pool = db.pool;
  smtp = await startFakeSmtp("ok");
  dir = await mkdtemp(path.join(tmpdir(), "resume-worker-"));
  storage = createLocalStorage({ dir });
});
after(async () => {
  await smtp?.close();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  smtp.state.bodies.length = 0;
  smtp.state.dataConnections = 0;
  smtp.setMode("ok");
  await pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM messages");
  await pool.query("DELETE FROM resumes");
  await pool.query("DELETE FROM settings WHERE key = 'send_hold'");
});

const tick = (o = {}) =>
  runTick({
    pool, mailer: o.mailer ?? smtp.transport(), config: { ...baseConfig, ...(o.config ?? {}) }, now: o.now ?? (() => new Date()),
    sleep: async () => {}, logger: silent, resumeStorage: o.storage ?? storage, resumeFetchTimeoutMs: o.fetchTimeoutMs,
  });
const msgRow = async (id) => (await pool.query("select * from messages where id=$1", [id])).rows[0];
const contactRow = async (id) => (await pool.query("select * from contacts where id=$1", [id])).rows[0];
const holdRow = async () => (await pool.query("select value from settings where key='send_hold'")).rows[0]?.value ?? null;

let n = 0;
async function addResume(displayName, tag = displayName, fileName = `${displayName}.pdf`) {
  const buffer = pdfBytes(tag);
  const r = await createResume(pool, storage, { displayName: `${displayName}-${++n}`, fileName, buffer });
  const row = (await pool.query("select * from resumes where id=$1", [r.id])).rows[0];
  return { ...r, buffer, key: row.storage_key, generation: row.generation };
}
// A due, scheduled initial that carries a resume snapshot.
async function dueWith(resume, { status = "scheduled", scheduledFor, followup = false } = {}) {
  const email = `rw${++n}@example.com`;
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status, followup_requested: followup } } });
  const m = await addMessage(pool, contacts[0].id, scheduledFor ? { scheduledFor } : {});
  if (resume) await pool.query("update messages set resume_id=$2, resume_generation=$3 where id=$1", [m.id, resume.id, resume.generation]);
  return { contact: contacts[0], msg: m, email };
}

// --- a tiny MIME reader: just enough to prove a REAL attachment arrived on the wire ---------------------
function parseMime(raw) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const unfold = head.replace(/\r\n[ \t]+/g, " ");
  const header = (name) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(unfold)?.[1] ?? "";
  const ct = header("Content-Type");
  const boundary = /boundary="?([^";\s]+)"?/i.exec(ct)?.[1];
  if (!boundary) return [{ headers: { ct, cd: header("Content-Disposition"), cte: header("Content-Transfer-Encoding") }, body }];
  const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
  return parts.flatMap((p) => parseMime(p.replace(/^\r\n/, "")));
}
function attachmentsOf(raw) {
  return parseMime(raw)
    .filter((p) => /^attachment/i.test(p.headers.cd))
    .map((p) => ({
      filename: /filename\*?=(?:"([^"]+)"|([^;\s]+))/i.exec(p.headers.cd)?.slice(1).find(Boolean),
      contentType: p.headers.ct.split(";")[0].trim().toLowerCase(),
      content: Buffer.from(p.body.replace(/\s+/g, ""), p.headers.cte.toLowerCase() === "base64" ? "base64" : "latin1"),
    }));
}

test("a real send carries the snapshotted library resume as a true PDF attachment (filename, application/pdf, exact bytes), not a link", async () => {
  const r = await addResume("Backend", "backend", "Harsh Khamkar - Backend.pdf");
  const { contact, msg } = await dueWith(r);
  const out = await tick();
  assert.equal(out.sent, 1);
  const atts = attachmentsOf(smtp.state.bodies[0]);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, "Harsh Khamkar - Backend.pdf");
  assert.equal(atts[0].contentType, "application/pdf");
  assert.ok(atts[0].content.equals(r.buffer), "bytes match the stored file");
  assert.doesNotMatch(smtp.state.bodies[0], /https?:\/\/[^\s"]*(storage\.googleapis|resume)/i, "no link to the file");
  assert.equal((await msgRow(msg.id)).state, "sent");
  assert.equal((await contactRow(contact.id)).status, "sent");
});

test("the follow-up carries the initial's snapshot, even after the default resume was replaced", async () => {
  const first = await addResume("First", "first");
  const { contact, msg } = await dueWith(first, { followup: true });
  assert.equal((await tick()).sent, 1);
  const fu = (await pool.query("select * from messages where contact_id=$1 and kind='followup'", [contact.id])).rows[0];
  assert.equal(fu.resume_id, first.id, "copied at creation");
  // The library moves on: a new default, the old resume soft-deleted (allowed: nothing pending uses it... except this follow-up).
  const second = await addResume("Second", "second");
  await pool.query("update resumes set is_default=false where is_default");
  await pool.query("update resumes set is_default=true where id=$1", [second.id]);
  await pool.query("update messages set scheduled_for = now() - interval '1 minute' where id=$1", [fu.id]);
  smtp.state.bodies.length = 0;
  assert.equal((await tick()).sent, 1);
  const atts = attachmentsOf(smtp.state.bodies[0]);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, first.fileName);
  assert.ok(atts[0].content.equals(first.buffer), "still the first resume's bytes");
  assert.equal(msg.id === fu.id, false);
});

test("a soft-deleted resume whose object remains still sends (history is explainable and follow-ups keep working)", async () => {
  const r = await addResume("Old", "old");
  const { msg } = await dueWith(r);
  await pool.query("update resumes set deleted_at=now(), is_default=false where id=$1", [r.id]);
  assert.equal((await tick()).sent, 1);
  assert.ok(attachmentsOf(smtp.state.bodies[0])[0].content.equals(r.buffer));
  assert.equal((await msgRow(msg.id)).state, "sent");
});

test("fetch failure (object gone): HOLD. Nothing is sent, attempt not consumed, contact not failed, send_hold surfaced; others still go", async () => {
  const broken = await addResume("Broken", "broken");
  const fine = await addResume("Fine", "fine");
  const a = await dueWith(broken, { scheduledFor: new Date(Date.now() - 120_000) });
  const b = await dueWith(fine, { scheduledFor: new Date(Date.now() - 60_000) });
  await unlink(path.join(dir, broken.key));
  const t0 = Date.now();
  const out = await tick({ now: () => new Date(t0) });
  assert.equal(out.held, 1);
  assert.equal(out.sent, 1, "a missing resume is specific to its messages; the other resume's mail still goes out");
  assert.equal(smtp.state.bodies.length, 1);
  assert.ok(attachmentsOf(smtp.state.bodies[0])[0].content.equals(fine.buffer));
  const row = await msgRow(a.msg.id);
  assert.equal(row.state, "scheduled");
  assert.equal(row.attempts, 0);
  assert.equal(row.claimed_at, null);
  const gap = row.scheduled_for.getTime() - t0;
  assert.ok(gap >= (HOLD_MINUTES - 1) * 60_000 && gap <= (HOLD_MINUTES + 1) * 60_000, `~15 min, got ${gap}`);
  assert.match(row.error, /resume/i);
  assert.doesNotMatch(row.error, new RegExp(broken.key), "the storage key is not leaked");
  assert.equal((await contactRow(a.contact.id)).status, "scheduled");
  const hold = await holdRow();
  assert.equal(hold.code, "ERESUME");
  assert.ok(hold.at);
  assert.ok((await pool.query("select 1 from events where type='send_held'")).rowCount >= 1);
  assert.equal((await msgRow(b.msg.id)).state, "sent");
  // b's success must not hide a's still-unresolved problem.
  assert.ok(await holdRow(), "marker stays while the held message is unresolved");
});

test("every storage failure kind (permission, network, unknown) holds; the message is never sent without its resume", async () => {
  for (const make of [
    () => new ResumeStorageError("permission"),
    () => new ResumeStorageError("unavailable"),
    () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    () => "not even an Error",
  ]) {
    const r = await addResume("Flaky", "flaky");
    const { msg, contact } = await dueWith(r);
    const failing = { ...storage, get: async () => { throw make(); } };
    const out = await tick({ storage: failing });
    assert.equal(out.held, 1);
    assert.equal(out.sent, 0);
    assert.equal(smtp.state.dataConnections, 0);
    const row = await msgRow(msg.id);
    assert.deepEqual([row.state, row.attempts], ["scheduled", 0]);
    assert.equal((await contactRow(contact.id)).status, "scheduled");
    await pool.query("delete from messages"); await pool.query("delete from settings where key='send_hold'");
  }
});

test("recovery: once the object is readable again, the held message sends after the hold window and the marker clears", async () => {
  const r = await addResume("Back", "back");
  const { msg } = await dueWith(r);
  let broken = true;
  const flaky = { ...storage, get: (k, g) => (broken ? Promise.reject(new ResumeStorageError("unavailable")) : storage.get(k, g)) };
  const t0 = Date.now();
  assert.equal((await tick({ storage: flaky, now: () => new Date(t0) })).held, 1);
  broken = false;
  assert.equal((await tick({ storage: flaky, now: () => new Date(t0 + 60_000) })).sent, 0, "not due yet");
  const out = await tick({ storage: flaky, now: () => new Date(t0 + (HOLD_MINUTES + 1) * 60_000) });
  assert.equal(out.sent, 1);
  assert.equal((await msgRow(msg.id)).attempts, 1);
  assert.equal(await holdRow(), null);
});

test("one download serves many mails in a tick (per-tick cache keyed by key+generation)", async () => {
  const r = await addResume("Cached", "cached");
  const other = await addResume("Other", "other");
  for (let i = 0; i < 3; i++) await dueWith(r);
  await dueWith(other);
  let gets = [];
  const counting = { ...storage, get: (k, g) => (gets.push(k), storage.get(k, g)) };
  const out = await tick({ storage: counting });
  assert.equal(out.sent, 4);
  assert.deepEqual([...new Set(gets)].sort(), [r.key, other.key].sort());
  assert.equal(gets.length, 2, "one fetch per distinct resume");
  // A second tick does not reuse bytes from the first: nothing is cached across ticks.
  await dueWith(r);
  await tick({ storage: counting });
  assert.equal(gets.length, 3);
});

test("dry-run never touches storage for a snapshotted resume, and still builds the message", async () => {
  const r = await addResume("Dry", "dry");
  const { msg } = await dueWith(r);
  let called = false;
  const spy = { ...storage, get: async () => { called = true; return Buffer.alloc(0); } };
  const out = await tick({ storage: spy, config: { dryRun: true }, mailer: (await import("../../src/mailer.js")).createMailer({ dryRun: true }) });
  assert.equal(out.sent, 1);
  assert.equal(called, false);
  assert.equal((await msgRow(msg.id)).dry_run, true);
});

test("legacy RESUME_PATH is the fallback when nothing is snapshotted: a real attachment named after the file", async () => {
  await dueWith(null);
  assert.equal((await tick({ config: { resumePath: LEGACY } })).sent, 1);
  const atts = attachmentsOf(smtp.state.bodies[0]);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].filename, "resume.pdf");
  assert.equal(atts[0].contentType, "application/pdf");
  assert.ok(atts[0].content.equals(readFileSync(LEGACY)));
});

test("a snapshotted library resume wins over the legacy file; no snapshot and no legacy path = no attachment", async () => {
  const r = await addResume("Wins", "wins");
  await dueWith(r);
  await tick({ config: { resumePath: LEGACY } });
  assert.ok(attachmentsOf(smtp.state.bodies[0])[0].content.equals(r.buffer));
  smtp.state.bodies.length = 0;
  await dueWith(null);
  await tick();
  assert.equal(attachmentsOf(smtp.state.bodies[0]).length, 0);
});

test("R1: a missing legacy RESUME_PATH file is a hold (pre-checked), not an ambiguous needs_review; nothing is sent", async () => {
  const { msg, contact } = await dueWith(null);
  const out = await tick({ config: { resumePath: "/nonexistent/dir/resume.pdf" } });
  assert.equal(out.held, 1);
  assert.equal(out.needsReview, 0);
  assert.equal(smtp.state.dataConnections, 0);
  const row = await msgRow(msg.id);
  assert.deepEqual([row.state, row.attempts], ["scheduled", 0]);
  assert.equal((await contactRow(contact.id)).status, "scheduled");
  assert.ok(await holdRow());
  assert.doesNotMatch(row.error, /nonexistent/, "no path in the stored note");
});

test("R1: dry-run is lenient about a missing legacy file (like the signature): the preview mail is built without it", async () => {
  const { msg } = await dueWith(null);
  const out = await tick({ config: { dryRun: true, resumePath: "/nonexistent/resume.pdf" }, mailer: (await import("../../src/mailer.js")).createMailer({ dryRun: true }) });
  assert.equal(out.sent, 1);
  assert.equal((await msgRow(msg.id)).state, "sent");
});

test("R2: while a systemic hold is younger than 15 minutes the tick claims nothing (no auth retry every 30 s); after that it tries once", async () => {
  await dueWith(null);
  const bad = smtp.transport({ auth: { user: "u", pass: "wrong" } });
  smtp.setMode("reject-auth");
  const t0 = Date.now();
  const first = await tick({ mailer: bad, now: () => new Date(t0) });
  assert.equal(first.held, 1);
  // Make the message due again right away (as another message would be) and tick repeatedly inside the window.
  await pool.query("update messages set scheduled_for = now() - interval '1 minute'");
  for (const secs of [30, 60, 300, 14 * 60]) {
    const s = await tick({ mailer: bad, now: () => new Date(t0 + secs * 1000) });
    assert.equal(s.claimed, 0, `no claim at +${secs}s`);
    assert.equal(s.paused, true);
  }
  const later = await tick({ mailer: bad, now: () => new Date(t0 + (HOLD_MINUTES + 1) * 60_000) });
  assert.equal(later.claimed, 1, "one attempt after the window");
  assert.equal(later.held, 1);
  // The window restarts from the new failure.
  const again = await tick({ mailer: bad, now: () => new Date(t0 + (HOLD_MINUTES + 2) * 60_000) });
  assert.equal(again.claimed, 0);
});

test("R2: the pause never applies in dry-run, and a resume-scoped hold does not pause other mail", async () => {
  await pool.query("insert into settings(key, value) values ('send_hold', $1)", [JSON.stringify({ at: new Date().toISOString(), code: "EAUTH", message: "x" })]);
  const dry = await dueWith(null);
  const mailer = (await import("../../src/mailer.js")).createMailer({ dryRun: true });
  assert.equal((await tick({ config: { dryRun: true }, mailer })).sent, 1, "dry-run ignores a real-mode hold");
  assert.equal((await msgRow(dry.msg.id)).state, "sent");
  await pool.query("update settings set value = $1 where key='send_hold'", [JSON.stringify({ at: new Date().toISOString(), code: "ERESUME", scope: "resume", messageId: "x", message: "x" })]);
  await dueWith(null);
  assert.equal((await tick()).sent, 1);
});

test("a download that never finishes times out into a hold instead of an in-flight send", async () => {
  const r = await addResume("Hang", "hang");
  const { msg } = await dueWith(r);
  const hanging = { ...storage, get: () => new Promise(() => {}) };
  const out = await tick({ storage: hanging, fetchTimeoutMs: 50 });
  assert.equal(out.held, 1);
  assert.equal(smtp.state.dataConnections, 0);
  assert.deepEqual([(await msgRow(msg.id)).state, (await msgRow(msg.id)).attempts], ["scheduled", 0]);
});
