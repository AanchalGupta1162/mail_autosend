import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

let t, c;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

const resolve = (id, action, client = c) => client.post(`/api/messages/${id}/resolve`, action === undefined ? {} : { action });
const contactRow = async (id) => (await t.pool.query("select * from contacts where id=$1", [id])).rows[0];
const msgRows = async (contactId) => (await t.pool.query("select * from messages where contact_id=$1 order by created_at", [contactId])).rows;
const events = async (contactId, type) => (await t.pool.query("select * from events where contact_id=$1 and type=$2", [contactId, type])).rows;
let n = 0;
const em = () => `r${++n}@example.com`;

async function needsReview({ kind = "initial", contact = {} } = {}) {
  const { contacts } = await seedBatch(t.pool, [em()], { overrides: {} });
  const ct = contacts[0];
  const o = { status: kind === "initial" ? "scheduled" : "sent", ...contact };
  await t.pool.query("update contacts set status=$2, followup_requested=$3 where id=$1", [ct.id, o.status, o.followup_requested ?? false]);
  const m = await addMessage(t.pool, ct.id, { kind, state: "needs_review", attempts: 3, messageId: "<orig@mail-autosender.local>", claimedAt: new Date(Date.now() - 3600_000) });
  if (kind === "followup") await addMessage(t.pool, ct.id, { kind: "initial", state: "sent", sentAt: new Date(Date.now() - 86400_000), messageId: "<init@x>" });
  return { ct, m };
}

test("resolve requires auth and CSRF", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  assert.equal((await t.client().post(`/api/messages/${id}/resolve`, { action: "cancel" })).status, 401);
  const noCsrf = t.client();
  await noCsrf.login();
  assert.equal((await noCsrf.raw("POST", `/api/messages/${id}/resolve`, { body: { action: "cancel" }, csrf: false })).status, 403);
});

test("validation: bad id 400, unknown message 404, bad/missing/extra fields 400", async () => {
  assert.equal((await c.post("/api/messages/not-a-uuid/resolve", { action: "cancel" })).status, 400);
  assert.equal((await resolve("00000000-0000-4000-8000-000000000000", "cancel")).status, 404);
  const { m } = await needsReview();
  assert.equal((await resolve(m.id, "explode")).status, 400);
  assert.equal((await resolve(m.id)).status, 400);
  assert.equal((await c.post(`/api/messages/${m.id}/resolve`, { action: "cancel", extra: 1 })).status, 400);
  assert.equal((await t.pool.query("select state from messages where id=$1", [m.id])).rows[0].state, "needs_review");
});

test("only a needs_review message can be resolved (409 otherwise)", async () => {
  const { contacts } = await seedBatch(t.pool, [em()]);
  const m = await addMessage(t.pool, contacts[0].id, { state: "scheduled" });
  assert.equal((await resolve(m.id, "cancel")).status, 409);
  assert.equal((await t.pool.query("select state from messages where id=$1", [m.id])).rows[0].state, "scheduled");
});

test("mark_sent (initial): message sent, contact sent, follow-up created when ticked, event written, uppercase id accepted", async () => {
  const { ct, m } = await needsReview({ contact: { followup_requested: true } });
  const r = await resolve(m.id.toUpperCase(), "mark_sent");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.message.state, "sent");
  assert.ok(r.json.message.sentAt);
  assert.equal(r.json.contact.status, "sent");
  const rows = await msgRows(ct.id);
  const fu = rows.find((x) => x.kind === "followup");
  assert.equal(fu.state, "scheduled");
  assert.ok(new Date(fu.scheduled_for) > new Date(Date.now() + 6 * 86400_000));
  assert.equal((await events(ct.id, "needs_review_resolved")).length, 1);
});

test("mark_sent (initial) without the follow-up tick creates no follow-up", async () => {
  const { ct, m } = await needsReview();
  assert.equal((await resolve(m.id, "mark_sent")).status, 200);
  assert.equal((await msgRows(ct.id)).filter((x) => x.kind === "followup").length, 0);
});

test("mark_sent (follow-up): message sent, contact unchanged", async () => {
  const { ct, m } = await needsReview({ kind: "followup", contact: { followup_requested: true } });
  const r = await resolve(m.id, "mark_sent");
  assert.equal(r.status, 200);
  assert.equal(r.json.message.state, "sent");
  assert.equal((await contactRow(ct.id)).status, "sent");
});

test("requeue: back to scheduled now, same Message-ID kept for threading/reply detection, attempts reset, contact stays scheduled", async () => {
  const { ct, m } = await needsReview();
  const r = await resolve(m.id, "requeue");
  assert.equal(r.status, 200, r.text);
  const row = (await msgRows(ct.id))[0];
  assert.equal(row.state, "scheduled");
  assert.equal(row.message_id, "<orig@mail-autosender.local>");
  assert.equal(row.error, null);
  assert.equal(row.attempts, 0, "a requeued message gets a fresh retry budget");
  assert.ok(new Date(row.scheduled_for) <= new Date());
  assert.equal((await contactRow(ct.id)).status, "scheduled");
});

test("requeue is refused when the contact replied / opted out / is suppressed", async () => {
  for (const status of ["replied", "opted_out", "bounced", "failed"]) {
    const { ct, m } = await needsReview({ contact: { status } });
    const r = await resolve(m.id, "requeue");
    assert.equal(r.status, 409, status);
    assert.equal((await msgRows(ct.id))[0].state, "needs_review");
  }
  const { ct, m } = await needsReview();
  await t.pool.query("insert into suppressions(email, reason) select lower(email), 'opt_out' from contacts where id=$1", [ct.id]);
  assert.equal((await resolve(m.id, "requeue")).status, 409);
});

test("cancel (initial): message cancelled, contact back to uploaded; cancel (follow-up): follow-up flag cleared", async () => {
  const a = await needsReview();
  const r = await resolve(a.m.id, "cancel");
  assert.equal(r.status, 200);
  assert.equal(r.json.message.state, "cancelled");
  assert.equal((await contactRow(a.ct.id)).status, "uploaded");
  const b = await needsReview({ kind: "followup", contact: { followup_requested: true } });
  assert.equal((await resolve(b.m.id, "cancel")).status, 200);
  const cb = await contactRow(b.ct.id);
  assert.equal(cb.status, "sent");
  assert.equal(cb.followup_requested, false);
});

test("a second resolve of the same message is 409 and changes nothing", async () => {
  const { ct, m } = await needsReview();
  assert.equal((await resolve(m.id, "mark_sent")).status, 200);
  assert.equal((await resolve(m.id, "requeue")).status, 409);
  assert.equal((await msgRows(ct.id))[0].state, "sent");
});
