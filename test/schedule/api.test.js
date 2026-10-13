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

const future = (ms) => new Date(Date.now() + ms).toISOString();
const H = 3600_000;
const D = 24 * H;
const put = (p, body) => c.raw("PUT", p, { body });
const del = (p) => c.raw("DELETE", p);
const bulk = (batchId, body) => c.post(`/api/batches/${batchId}/schedule`, body);
const msgs = async (contactId) => (await t.pool.query("select * from messages where contact_id=$1 order by created_at", [contactId])).rows;
const contactRow = async (id) => (await t.pool.query("select * from contacts where id=$1", [id])).rows[0];
let n = 0;
const em = (p = "u") => `${p}${++n}@example.com`;

test("every scheduling route requires auth and CSRF", async () => {
  const anon = t.client();
  const id = "00000000-0000-4000-8000-000000000000";
  for (const [m, p] of [["POST", `/api/batches/${id}/schedule`], ["PUT", `/api/contacts/${id}/schedule`], ["PUT", `/api/contacts/${id}/followup`], ["DELETE", `/api/messages/${id}`], ["GET", "/api/template/followup"], ["PUT", "/api/template/followup"]]) {
    assert.equal((await anon.raw(m, p)).status, 401, `${m} ${p}`);
  }
  const noCsrf = t.client();
  await noCsrf.login();
  assert.equal((await noCsrf.raw("PUT", `/api/contacts/${id}/schedule`, { body: {}, csrf: false })).status, 403);
});

test("ids are case-insensitive: uppercase UUIDs work and a differently-cased duplicate is still a duplicate", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, [em(), em()]);
  const dup = await bulk(batchId, { contactIds: [contacts[0].id, contacts[0].id.toUpperCase()], sendAt: future(2 * D) });
  assert.equal(dup.status, 400);
  assert.deepEqual(await msgs(contacts[0].id), []);
  const upper = await bulk(batchId, { contactIds: [contacts[1].id.toUpperCase()], sendAt: future(2 * D) });
  assert.equal(upper.status, 201, upper.text);
  const one = await put(`/api/contacts/${contacts[0].id.toUpperCase()}/schedule`, { sendAt: future(2 * D) });
  assert.equal(one.status, 200, one.text);
});

test("bulk schedule creates scheduled messages, staggered in contactIds order", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, [em(), em(), em()]);
  const order = [contacts[2].id, contacts[0].id, contacts[1].id];
  const sendAt = future(2 * D);
  const r = await bulk(batchId, { contactIds: order, sendAt, staggerMinutes: 10 });
  assert.equal(r.status, 201, r.text);
  const base = new Date(sendAt).getTime();
  assert.deepEqual(r.json.messages.map((m) => m.contactId), order);
  assert.deepEqual(r.json.messages.map((m) => new Date(m.scheduledFor).getTime()), [base, base + 600_000, base + 1_200_000]);
  for (const cid of order) {
    const [m] = await msgs(cid);
    assert.equal(m.kind, "initial");
    assert.equal(m.state, "scheduled");
    assert.equal((await contactRow(cid)).status, "scheduled");
  }
  assert.equal(Number((await t.pool.query("select count(*) n from events where type='scheduled'")).rows[0].n) >= 3, true);
});

test("sendAt validation: past, malformed, >90 days, and stagger pushing past 90 days are 400 and create nothing", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, [em(), em()]);
  const ids = contacts.map((x) => x.id);
  for (const body of [
    { contactIds: ids, sendAt: future(-H) },
    { contactIds: ids, sendAt: "next tuesday" },
    { contactIds: ids, sendAt: future(91 * D) },
    { contactIds: ids, sendAt: future(89 * D + 23 * H), staggerMinutes: 120 },
    { contactIds: ids, sendAt: future(D), staggerMinutes: -1 },
    { contactIds: ids, sendAt: future(D), staggerMinutes: 1.5 },
    { contactIds: ids, sendAt: future(D), extra: 1 },
    { contactIds: [], sendAt: future(D) },
    { contactIds: [ids[0], ids[0]], sendAt: future(D) },
    { contactIds: ["nope"], sendAt: future(D) },
  ]) {
    const r = await bulk(batchId, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await msgs(ids[0])).length, 0);
  assert.equal((await bulk("not-a-uuid", { contactIds: ids, sendAt: future(D) })).status, 400);
  assert.equal((await bulk("00000000-0000-4000-8000-000000000000", { contactIds: ids, sendAt: future(D) })).status, 404);
});

test("(a) bulk is all-or-nothing: suppressed, replied, bounced, opted_out, failed, other-batch and foreign contacts are refused with names", async () => {
  const supp = em("supp");
  const rep = em("rep");
  const bnc = em("bnc");
  const opt = em("opt");
  const fld = em("fld");
  const cross = em("cross");
  const crossB = em("crossb");
  const crossO = em("crosso");
  const sent = em("sent");
  const ok = em("ok");
  await t.pool.query("insert into suppressions(email, reason) values ($1,'manual')", [supp.toLowerCase()]);
  const { batchId, contacts } = await seedBatch(t.pool, [supp, rep, bnc, opt, fld, cross, crossB, crossO, sent, ok], {
    overrides: { [rep]: { status: "replied" }, [bnc]: { status: "bounced" }, [opt]: { status: "opted_out" }, [fld]: { status: "failed" }, [sent]: { status: "sent" } },
  });
  // same people replied / bounced / opted out in OTHER batches (different case on purpose)
  await seedBatch(t.pool, [cross.toUpperCase()], { overrides: { [cross.toUpperCase()]: { status: "replied" } } });
  await seedBatch(t.pool, [crossB], { overrides: { [crossB]: { status: "bounced" } } });
  await seedBatch(t.pool, [crossO], { overrides: { [crossO]: { status: "opted_out" } } });
  const other = await seedBatch(t.pool, [em()]);
  const by = Object.fromEntries(contacts.map((x) => [x.email, x.id]));

  const r = await bulk(batchId, { contactIds: [...contacts.map((x) => x.id), other.contacts[0].id], sendAt: future(D) });
  assert.equal(r.status, 409, r.text);
  const reasons = Object.fromEntries(r.json.refused.map((x) => [x.contactId, x.reason]));
  assert.equal(reasons[by[supp]], "suppressed");
  assert.equal(reasons[by[rep]], "replied");
  assert.equal(reasons[by[bnc]], "bounced");
  assert.equal(reasons[by[opt]], "opted_out");
  assert.equal(reasons[by[fld]], "failed");
  assert.equal(reasons[by[cross]], "other_batch_replied");
  assert.equal(reasons[by[crossB]], "other_batch_bounced");
  assert.equal(reasons[by[crossO]], "other_batch_opted_out");
  assert.equal(reasons[by[sent]], "already_sent");
  assert.equal(reasons[other.contacts[0].id], "not_in_batch");
  assert.equal(reasons[by[ok]], undefined);
  assert.equal(r.json.refused.find((x) => x.contactId === by[supp]).email, supp);
  // all-or-nothing: the valid contact was NOT scheduled
  assert.equal((await msgs(by[ok])).length, 0);
  assert.equal((await contactRow(by[ok])).status, "uploaded");
});

test("per-contact schedule: schedule, reschedule, and refusals (suppressed, replied, cross-batch, sent)", async () => {
  const a = em();
  const s = em("s");
  const x = em("x");
  const { contacts } = await seedBatch(t.pool, [a, s, x]);
  await seedBatch(t.pool, [x], { overrides: { [x]: { status: "opted_out" } } });
  await t.pool.query("insert into suppressions(email) values ($1)", [s.toLowerCase()]);

  const t1 = future(2 * D);
  const r1 = await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: t1 });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(new Date(r1.json.message.scheduledFor).toISOString(), t1);
  assert.equal((await contactRow(contacts[0].id)).status, "scheduled");

  const t2 = future(3 * D);
  const r2 = await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: t2 });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.message.id, r1.json.message.id, "reschedule updates the same message");
  const rows = await msgs(contacts[0].id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scheduled_for.toISOString(), t2);

  assert.equal((await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(-H) })).status, 400);
  assert.equal((await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(D), junk: 1 })).status, 400);

  for (const [i, why] of [[1, "suppressed"], [2, "other_batch_opted_out"]]) {
    const r = await put(`/api/contacts/${contacts[i].id}/schedule`, { sendAt: future(D) });
    assert.equal(r.status, 409);
    assert.equal(r.json.refused[0].reason, why);
    assert.equal((await msgs(contacts[i].id)).length, 0);
  }
  assert.equal((await put(`/api/contacts/00000000-0000-4000-8000-000000000000/schedule`, { sendAt: future(D) })).status, 404);

  // a message already being sent can't be rescheduled
  await t.pool.query("update messages set state='sending', claimed_at=now() where contact_id=$1", [contacts[0].id]);
  assert.equal((await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(D) })).status, 409);
});

test("a contact that became replied after scheduling cannot be rescheduled", async () => {
  const { contacts } = await seedBatch(t.pool, [em()]);
  await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(D) });
  await c.post(`/api/contacts/${contacts[0].id}/mark-replied`, {});
  const r = await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(D) });
  assert.equal(r.status, 409);
  assert.equal(r.json.refused[0].reason, "replied");
});

test("DELETE /messages/:id cancels a scheduled initial and returns the contact to uploaded", async () => {
  const { contacts } = await seedBatch(t.pool, [em()]);
  const r = await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(D) });
  const d = await del(`/api/messages/${r.json.message.id}`);
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.message.state, "cancelled");
  assert.equal((await contactRow(contacts[0].id)).status, "uploaded");
  // can be scheduled again afterwards
  assert.equal((await put(`/api/contacts/${contacts[0].id}/schedule`, { sendAt: future(D) })).status, 200);
  assert.equal((await msgs(contacts[0].id)).filter((m) => m.state === "scheduled").length, 1);
  // cancelling twice / non-scheduled / unknown
  assert.equal((await del(`/api/messages/${r.json.message.id}`)).status, 409);
  assert.equal((await del(`/api/messages/00000000-0000-4000-8000-000000000000`)).status, 404);
  assert.equal((await del(`/api/messages/nope`)).status, 400);
});

test("follow-up: enabling before the initial is sent only stores the flag; untick clears it", async () => {
  const { contacts } = await seedBatch(t.pool, [em()]);
  const id = contacts[0].id;
  const r = await put(`/api/contacts/${id}/followup`, { enabled: true, delayDays: 10 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.contact.followupRequested, true);
  assert.equal(r.json.contact.followupDelayDays, 10);
  assert.equal(r.json.followup, null);
  assert.equal((await msgs(id)).length, 0);
  const off = await put(`/api/contacts/${id}/followup`, { enabled: false });
  assert.equal(off.json.contact.followupRequested, false);
});

test("follow-up: enabling after the initial was sent creates a scheduled follow-up at sent_at + delay; delay change moves it; untick cancels it; re-tick recreates", async () => {
  const { contacts } = await seedBatch(t.pool, [em()], { overrides: {} });
  const id = contacts[0].id;
  const sentAt = new Date(Date.now() - 2 * D);
  await t.pool.query("update contacts set status='sent' where id=$1", [id]);
  await addMessage(t.pool, id, { kind: "initial", state: "sent", sentAt, messageId: "<m1@x>" });

  const r = await put(`/api/contacts/${id}/followup`, { enabled: true, delayDays: 7 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.followup.kind, "followup");
  assert.equal(r.json.followup.state, "scheduled");
  assert.equal(new Date(r.json.followup.scheduledFor).getTime(), sentAt.getTime() + 7 * D);

  const r2 = await put(`/api/contacts/${id}/followup`, { enabled: true, delayDays: 14 });
  assert.equal(new Date(r2.json.followup.scheduledFor).getTime(), sentAt.getTime() + 14 * D);
  assert.equal(r2.json.followup.id, r.json.followup.id);
  assert.equal((await msgs(id)).filter((m) => m.kind === "followup").length, 1);

  const off = await put(`/api/contacts/${id}/followup`, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.followup, null);
  assert.deepEqual((await msgs(id)).filter((m) => m.kind === "followup").map((m) => m.state), ["cancelled"]);

  const on = await put(`/api/contacts/${id}/followup`, { enabled: true });
  assert.equal(on.json.followup.state, "scheduled");
  assert.deepEqual((await msgs(id)).filter((m) => m.kind === "followup").map((m) => m.state), ["cancelled", "scheduled"]);
});

test("follow-up validation: delay 1-60, strict body", async () => {
  const { contacts } = await seedBatch(t.pool, [em()]);
  const p = `/api/contacts/${contacts[0].id}/followup`;
  for (const body of [{ enabled: true, delayDays: 0 }, { enabled: true, delayDays: 61 }, { enabled: true, delayDays: 1.5 }, { enabled: "yes" }, {}, { enabled: true, x: 1 }]) {
    assert.equal((await put(p, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await put(p, { enabled: true, delayDays: 1 })).status, 200);
  assert.equal((await put(p, { enabled: true, delayDays: 60 })).status, 200);
  assert.equal((await put("/api/contacts/00000000-0000-4000-8000-000000000000/followup", { enabled: true })).status, 404);
});

test("(a) follow-up enabling is refused for suppressed / replied / bounced / opted-out / failed / cross-batch contacts", async () => {
  const e = { s: em(), r: em(), b: em(), o: em(), f: em(), x: em() };
  const { contacts } = await seedBatch(t.pool, Object.values(e), {
    overrides: { [e.r]: { status: "replied" }, [e.b]: { status: "bounced" }, [e.o]: { status: "opted_out" }, [e.f]: { status: "failed" } },
  });
  await t.pool.query("insert into suppressions(email) values ($1)", [e.s.toLowerCase()]);
  await seedBatch(t.pool, [e.x], { overrides: { [e.x]: { status: "replied" } } });
  const want = ["suppressed", "replied", "bounced", "opted_out", "failed", "other_batch_replied"];
  for (const [i, why] of want.entries()) {
    const r = await put(`/api/contacts/${contacts[i].id}/followup`, { enabled: true });
    assert.equal(r.status, 409, why);
    assert.equal(r.json.refused[0].reason, why);
    assert.equal((await contactRow(contacts[i].id)).followup_requested, false);
  }
  // disabling is always allowed
  assert.equal((await put(`/api/contacts/${contacts[1].id}/followup`, { enabled: false })).status, 200);
});

test("template: get default, put new, validation, round trip", async () => {
  const g = await c.get("/api/template/followup");
  assert.equal(g.status, 200);
  assert.equal(g.json.template.subject, "Re: {{subject}}");
  const p = await put("/api/template/followup", { subject: "Re: {{subject}} (quick nudge)", body: "Hi {{firstName}}, ping." });
  assert.equal(p.status, 200, p.text);
  assert.equal((await c.get("/api/template/followup")).json.template.body, "Hi {{firstName}}, ping.");
  for (const body of [{ subject: "", body: "x" }, { subject: "a\r\nBcc: z@z.z", body: "x" }, { subject: "a" }, { subject: "a", body: "x", extra: 1 }, { subject: "a", body: "x".repeat(5001) }]) {
    assert.equal((await put("/api/template/followup", body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  await put("/api/template/followup", { subject: "Re: {{subject}}", body: "Hi {{firstName}},\n\nJust following up." });
});
