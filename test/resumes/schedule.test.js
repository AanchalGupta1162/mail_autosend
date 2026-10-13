import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

const pdfBytes = (tag) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
const NOW_PAST = () => new Date(Date.now() - 3600_000);
const SIGNATURE = path.resolve("test/fixtures/sig-fixture.html");
let t, c, dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "resume-sched-"));
  t = await startTestApp({ RESUME_LOCAL_DIR: dir });
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => {
  await t?.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await t.pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
  await t.pool.query("DELETE FROM resumes");
});

async function addResume(displayName, { isDefault = false } = {}) {
  const f = new FormData();
  f.append("displayName", displayName);
  f.append("file", new Blob([pdfBytes(displayName)], { type: "application/pdf" }), `${displayName}.pdf`);
  const r = await c.raw("POST", "/api/resumes", { rawBody: f });
  assert.equal(r.status, 201, r.text);
  if (isDefault) await c.raw("PUT", `/api/resumes/${r.json.resume.id}`, { body: { isDefault: true } });
  return r.json.resume;
}
const snapshot = async (contactId) => (await t.pool.query("SELECT m.resume_id, m.resume_generation, r.generation AS current_generation FROM messages m LEFT JOIN resumes r ON r.id = m.resume_id WHERE m.contact_id = $1 AND m.kind = 'initial' AND m.state <> 'cancelled'", [contactId])).rows[0];
const scheduleAll = (batchId, contactIds, extra = {}) => c.post(`/api/batches/${batchId}/schedule`, { contactIds, sendAt: FUTURE(), ...extra });

test("batch schedule with resumeId stores the batch choice and snapshots it (id + generation) on each initial message", async () => {
  const general = await addResume("General", { isDefault: true });
  const backend = await addResume("Backend");
  const { batchId, contacts } = await seedBatch(t.pool, ["a@x.com", "b@x.com"]);
  const r = await scheduleAll(batchId, contacts.map((x) => x.id), { resumeId: backend.id });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.messages[0].resumeId, backend.id);
  assert.equal((await t.pool.query("SELECT resume_id FROM batches WHERE id = $1", [batchId])).rows[0].resume_id, backend.id);
  for (const ct of contacts) {
    const s = await snapshot(ct.id);
    assert.equal(s.resume_id, backend.id);
    assert.equal(s.resume_generation, s.current_generation);
    assert.ok(s.resume_generation);
  }
  assert.notEqual(general.id, backend.id);
});

test("resolution order: contact override, then batch choice, then the default, then nothing", async () => {
  const dflt = await addResume("Default", { isDefault: true });
  const batchPick = await addResume("BatchPick");
  const contactPick = await addResume("ContactPick");
  const { batchId, contacts } = await seedBatch(t.pool, ["c1@x.com", "c2@x.com"]);
  // c1 has an override; c2 does not.
  assert.equal((await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: contactPick.id } })).status, 200);
  await scheduleAll(batchId, contacts.map((x) => x.id), { resumeId: batchPick.id });
  assert.equal((await snapshot(contacts[0].id)).resume_id, contactPick.id, "override beats batch");
  assert.equal((await snapshot(contacts[1].id)).resume_id, batchPick.id, "batch beats default");

  const b2 = await seedBatch(t.pool, ["d1@x.com"]);
  await scheduleAll(b2.batchId, [b2.contacts[0].id]);
  assert.equal((await snapshot(b2.contacts[0].id)).resume_id, dflt.id, "default is the fallback");

  await c.raw("PUT", `/api/resumes/${dflt.id}`, { body: { isDefault: false } });
  const b3 = await seedBatch(t.pool, ["e1@x.com"]);
  const r = await scheduleAll(b3.batchId, [b3.contacts[0].id]);
  assert.equal(r.status, 201);
  assert.equal((await snapshot(b3.contacts[0].id)).resume_id, null, "dry-run with nothing chosen: no resume");
});

test("a soft-deleted resume is never resolved: it falls through to the next level", async () => {
  const dflt = await addResume("Default", { isDefault: true });
  const gone = await addResume("Gone");
  const { batchId, contacts } = await seedBatch(t.pool, ["g@x.com"]);
  await t.pool.query("UPDATE batches SET resume_id = $1 WHERE id = $2", [gone.id, batchId]);
  await t.pool.query("UPDATE resumes SET deleted_at = now() WHERE id = $1", [gone.id]);
  await scheduleAll(batchId, [contacts[0].id]);
  assert.equal((await snapshot(contacts[0].id)).resume_id, dflt.id);
});

test("resumeId is validated: unknown, deleted, malformed and extra fields are refused and schedule nothing", async () => {
  const gone = await addResume("Gone");
  await c.raw("DELETE", `/api/resumes/${gone.id}`);
  const { batchId, contacts } = await seedBatch(t.pool, ["v@x.com"]);
  for (const resumeId of ["6b0e3c1e-0000-4000-8000-000000000000", gone.id]) {
    const r = await scheduleAll(batchId, [contacts[0].id], { resumeId });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, /resume/i);
  }
  assert.equal((await scheduleAll(batchId, [contacts[0].id], { resumeId: "nope" })).status, 400);
  assert.equal((await scheduleAll(batchId, [contacts[0].id], { resumeid: "x" })).status, 400);
  assert.equal((await t.pool.query("SELECT count(*)::int n FROM messages")).rows[0].n, 0);
  assert.equal((await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: gone.id } })).status, 400);
  assert.equal((await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: null, x: 1 } })).status, 400);
});

test("snapshot immutability: changing the default or the batch choice after scheduling does not touch scheduled messages", async () => {
  const first = await addResume("First", { isDefault: true });
  const second = await addResume("Second");
  const { batchId, contacts } = await seedBatch(t.pool, ["s@x.com"]);
  await scheduleAll(batchId, [contacts[0].id]);
  const before = await snapshot(contacts[0].id);
  assert.equal(before.resume_id, first.id);
  await c.raw("PUT", `/api/resumes/${second.id}`, { body: { isDefault: true } });
  await t.pool.query("UPDATE batches SET resume_id = $1 WHERE id = $2", [second.id, batchId]);
  assert.deepEqual(await snapshot(contacts[0].id), before);
});

test("rescheduling keeps the snapshot unless a resumeId is given", async () => {
  const first = await addResume("First", { isDefault: true });
  const second = await addResume("Second");
  const { batchId, contacts } = await seedBatch(t.pool, ["r@x.com"]);
  await scheduleAll(batchId, [contacts[0].id]);
  await c.raw("PUT", `/api/resumes/${second.id}`, { body: { isDefault: true } });
  assert.equal((await c.raw("PUT", `/api/contacts/${contacts[0].id}/schedule`, { body: { sendAt: FUTURE() } })).status, 200);
  assert.equal((await snapshot(contacts[0].id)).resume_id, first.id, "kept");
  const r = await c.raw("PUT", `/api/contacts/${contacts[0].id}/schedule`, { body: { sendAt: FUTURE(), resumeId: second.id } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await snapshot(contacts[0].id)).resume_id, second.id, "explicit choice applies");
  assert.equal((await t.pool.query("SELECT resume_id FROM contacts WHERE id = $1", [contacts[0].id])).rows[0].resume_id, second.id);
});

test("PUT /contacts/:id/resume sets or clears the override; it re-snapshots a still-scheduled initial and refuses sent contacts", async () => {
  const first = await addResume("First", { isDefault: true });
  const second = await addResume("Second");
  const { batchId, contacts } = await seedBatch(t.pool, ["o@x.com", "p@x.com"]);
  await scheduleAll(batchId, [contacts[0].id]);
  const set = await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: second.id } });
  assert.equal(set.status, 200);
  assert.equal(set.json.contact.resumeId, second.id);
  assert.equal((await snapshot(contacts[0].id)).resume_id, second.id);
  const clear = await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: null } });
  assert.equal(clear.json.contact.resumeId, null);
  assert.equal((await snapshot(contacts[0].id)).resume_id, first.id, "back to the default");
  await t.pool.query("UPDATE contacts SET status = 'sent' WHERE id = $1", [contacts[1].id]);
  assert.equal((await c.raw("PUT", `/api/contacts/${contacts[1].id}/resume`, { body: { resumeId: second.id } })).status, 409);
  assert.equal((await c.raw("PUT", "/api/contacts/6b0e3c1e-0000-4000-8000-000000000000/resume", { body: { resumeId: null } })).status, 404);
  assert.equal((await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: null }, csrf: false })).status, 403);
});

test("a follow-up created later copies the initial's snapshot (checkbox after send, and mark_sent)", async () => {
  const first = await addResume("First", { isDefault: true });
  const { contacts } = await seedBatch(t.pool, ["f1@x.com", "f2@x.com"], { overrides: { "f1@x.com": { status: "sent" }, "f2@x.com": { status: "scheduled", followup_requested: true } } });
  const sent = await addMessage(t.pool, contacts[0].id, { state: "sent", sentAt: new Date(), messageId: "<i@x>" });
  await t.pool.query("UPDATE messages SET resume_id = $1, resume_generation = 'g-old' WHERE id = $2", [first.id, sent.id]);
  const r = await c.raw("PUT", `/api/contacts/${contacts[0].id}/followup`, { body: { enabled: true, delayDays: 3 } });
  assert.equal(r.status, 200, r.text);
  const fu = (await t.pool.query("SELECT resume_id, resume_generation FROM messages WHERE contact_id = $1 AND kind = 'followup'", [contacts[0].id])).rows[0];
  assert.deepEqual(fu, { resume_id: first.id, resume_generation: "g-old" });

  const nr = await addMessage(t.pool, contacts[1].id, { state: "needs_review", messageId: "<n@x>" });
  await t.pool.query("UPDATE messages SET resume_id = $1, resume_generation = 'g-nr' WHERE id = $2", [first.id, nr.id]);
  const res = await c.post(`/api/messages/${nr.id}/resolve`, { action: "mark_sent" });
  assert.equal(res.status, 200, res.text);
  const fu2 = (await t.pool.query("SELECT resume_id, resume_generation FROM messages WHERE contact_id = $1 AND kind = 'followup'", [contacts[1].id])).rows[0];
  assert.deepEqual(fu2, { resume_id: first.id, resume_generation: "g-nr" });
});

test("contact lists and batch previews show which resume goes out (attachment) and where it came from", async () => {
  const dflt = await addResume("Default", { isDefault: true });
  const pick = await addResume("Pick");
  const { batchId, contacts } = await seedBatch(t.pool, ["l1@x.com", "l2@x.com"]);
  let list = (await c.get(`/api/contacts?batchId=${batchId}`)).json.contacts;
  assert.deepEqual(list.map((x) => x.attachment), [{ id: dflt.id, displayName: "Default", source: "default" }, { id: dflt.id, displayName: "Default", source: "default" }]);
  await c.raw("PUT", `/api/contacts/${contacts[0].id}/resume`, { body: { resumeId: pick.id } });
  await scheduleAll(batchId, [contacts[0].id, contacts[1].id]);
  await c.raw("PUT", `/api/resumes/${pick.id}`, { body: { isDefault: true } }); // does not change what is scheduled
  list = (await c.get(`/api/contacts?batchId=${batchId}`)).json.contacts;
  const byEmail = Object.fromEntries(list.map((x) => [x.email, x]));
  assert.deepEqual(byEmail["l1@x.com"].attachment, { id: pick.id, displayName: "Pick", source: "scheduled" });
  assert.deepEqual(byEmail["l2@x.com"].attachment, { id: dflt.id, displayName: "Default", source: "scheduled" });
  assert.equal(byEmail["l1@x.com"].resumeId, pick.id);
  const detail = (await c.get(`/api/batches/${batchId}`)).json;
  assert.equal(detail.contacts.find((x) => x.email === "l2@x.com").attachment.displayName, "Default");
  assert.equal(detail.batch.resumeId, null);
});

test("real mode refuses to schedule when no resume is chosen and there is no legacy RESUME_PATH; dry-run does not care", async () => {
  const real = await startTestApp({
    RESUME_LOCAL_DIR: dir, DRY_RUN: "false", GMAIL_USER: "me@example.com", GMAIL_APP_PASSWORD: "pw", SIGNATURE_PATH: SIGNATURE,
  });
  try {
    await real.addUser("admin");
    const rc = real.client();
    await rc.login();
    const { batchId, contacts } = await seedBatch(real.pool, ["rm@x.com"]);
    const r = await rc.post(`/api/batches/${batchId}/schedule`, { contactIds: [contacts[0].id], sendAt: FUTURE() });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, /resume/i);
    assert.equal((await real.pool.query("SELECT count(*)::int n FROM messages")).rows[0].n, 0);
    const f = new FormData();
    f.append("displayName", "Real");
    f.append("file", new Blob([pdfBytes("real")], { type: "application/pdf" }), "r.pdf");
    await rc.raw("POST", "/api/resumes", { rawBody: f }); // becomes the default
    const again = await rc.post(`/api/batches/${batchId}/schedule`, { contactIds: [contacts[0].id], sendAt: FUTURE() });
    assert.equal(again.status, 201, again.text);
  } finally {
    await real.close();
  }
});
