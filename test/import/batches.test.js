import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startTestApp } from "../helpers/app.js";
import { renderInitialPreview } from "../../src/domain/render.js";

const SAMPLE = readFileSync(new URL("../fixtures/sample.csv", import.meta.url));
const H = '"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"';
const line = (e, o = {}) =>
  ["Acme", "SWE", "Jo", e, o.s ?? "SWE role at Acme", o.m ?? "Hi Jo,\n\nHello **there**.\n\nBest,\nH", ""].map((x) => `"${x.replace(/"/g, '""')}"`).join(",");

let t, c;
before(async () => {
  t = await startTestApp();
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

function form({ content = SAMPLE, filename = "leads.csv", type = "text/csv", name, extra = {}, field = "file" } = {}) {
  const f = new FormData();
  if (content !== null) f.append(field, new Blob([content], { type }), filename);
  if (name !== undefined) f.append("name", name);
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
}
const upload = (opts, client = c) => client.raw("POST", "/api/batches", { rawBody: form(opts) });
const count = async (sql, p = []) => Number((await t.pool.query(sql, p)).rows[0].n);

test("renderInitialPreview returns plain text without markdown bold and with signature text", () => {
  const p = renderInitialPreview({ subject: "S", mailText: "Hi **Jo**" }, "<p>Sig</p>");
  assert.equal(p.subject, "S");
  assert.equal(p.text, "Hi Jo\n\nSig");
  assert.equal(p.html, undefined);
});

test("auth and CSRF are required for all batch/contact routes", async () => {
  const anon = t.client();
  for (const [m, p] of [["GET", "/api/batches"], ["POST", "/api/batches"], ["GET", "/api/batches/00000000-0000-4000-8000-000000000000"], ["GET", "/api/contacts"], ["POST", "/api/contacts/00000000-0000-4000-8000-000000000000/opt-out"], ["POST", "/api/contacts/00000000-0000-4000-8000-000000000000/mark-replied"]]) {
    assert.equal((await anon.raw(m, p)).status, 401, `${m} ${p}`);
  }
  const noCsrf = t.client();
  await noCsrf.login();
  noCsrf.csrf = null;
  const r = await noCsrf.raw("POST", "/api/batches", { rawBody: form(), csrf: false });
  assert.equal(r.status, 403);
});

test("valid upload: batch + contacts + rendered text preview; nothing scheduled", async () => {
  const r = await upload({ name: "October leads" });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.batch.name, "October leads");
  assert.equal(r.json.batch.originalFilename, "leads.csv");
  assert.equal(r.json.contacts.length, 5);
  assert.deepEqual(r.json.errors, []);
  const first = r.json.contacts[0];
  assert.equal(first.status, "uploaded");
  assert.equal(first.preview.subject, first.subject);
  assert.match(first.preview.text, /^Hi Aisha,/);
  assert.doesNotMatch(first.preview.text, /\*\*/);
  assert.equal(first.preview.html, undefined);
  assert.equal(await count("select count(*) n from messages"), 0);
  assert.equal(await count("select count(*) n from events where type='imported' and contact_id is not null"), 5);
  assert.equal(await count("select count(*) n from events where type='batch_created'"), 1);
});

test("name defaults to the sanitised, length-capped filename", async () => {
  const r = await upload({ filename: "we<ird>\"na\\me" + "x".repeat(300) + ".csv", content: Buffer.from(`${H}\n${line("n1@example.com")}`) });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.batch.name.length <= 120 && r.json.batch.name.length > 0);
  assert.doesNotMatch(r.json.batch.name, /[<>"\\\r\n]/);
});

test("BOM-prefixed CSV is accepted", async () => {
  const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${H}\n${line("bom@example.com")}`)]);
  const r = await upload({ content });
  assert.equal(r.status, 201);
  assert.equal(r.json.contacts.length, 1);
});

test("missing header column -> 400 and nothing inserted", async () => {
  const before = await count("select count(*) n from batches");
  const r = await upload({ content: Buffer.from('"Company","Role"\n"a","b"') });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Missing required column/);
  assert.equal(await count("select count(*) n from batches"), before);
});

test("bad rows are reported and skipped; good rows are inserted", async () => {
  const csv = [H, line("ok1@example.com"), line("bad"), line("ok2@example.com", { s: "x\r\nBcc: e@example.com" }), line("ok3@example.com"), line("OK1@example.com")].join("\n");
  const r = await upload({ content: Buffer.from(csv) });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.contacts.map((x) => x.email), ["ok1@example.com", "ok3@example.com"]);
  assert.deepEqual(r.json.errors.map((e) => e.row), [3, 4, 6]);
});

test("all rows invalid -> 422 with errors and no batch created", async () => {
  const before = await count("select count(*) n from batches");
  const r = await upload({ content: Buffer.from(`${H}\n${line("nope")}`) });
  assert.equal(r.status, 422);
  assert.equal(r.json.errors.length, 1);
  assert.equal(await count("select count(*) n from batches"), before);
});

test("suppressed emails are rejected per row", async () => {
  await t.pool.query("insert into suppressions(email, reason) values('sup@example.com','test')");
  const r = await upload({ content: Buffer.from(`${H}\n${line("Sup@Example.com")}\n${line("fine@example.com")}`) });
  assert.equal(r.status, 201);
  assert.equal(r.json.contacts.length, 1);
  assert.match(r.json.errors[0].message, /suppress/i);
});

test("upload limits: >1MB -> 413, >500 rows -> 400, wrong type -> 400, no file -> 400, extra fields -> 400", async () => {
  let r = await upload({ content: Buffer.alloc(1024 * 1024 + 10, "a") });
  assert.equal(r.status, 413);
  const many = [H, ...Array.from({ length: 501 }, (_, i) => line(`m${i}@example.com`))].join("\n");
  r = await upload({ content: Buffer.from(many) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /500/);
  for (const filename of ["leads.xlsx", "leads.csv.exe", "leads"]) {
    r = await upload({ filename });
    assert.equal(r.status, 400, filename);
  }
  r = await upload({ content: null });
  assert.equal(r.status, 400);
  r = await upload({ field: "other" });
  assert.equal(r.status, 400);
  r = await upload({ extra: { admin: "1" } });
  assert.equal(r.status, 400);
  r = await upload({ name: "bad\nname" });
  assert.equal(r.status, 400);
  r = await c.post("/api/batches", { a: 1 });
  assert.equal(r.status, 400);
});

test("CR/LF header injection attempts never reach the database", async () => {
  const evil = `${H}\n"A","R","P","x@example.com\r\nBcc: evil@example.com","S","M",""`;
  const r = await upload({ content: Buffer.from(evil) });
  assert.equal(r.status, 422);
  assert.equal(await count("select count(*) n from contacts where email like '%evil%'"), 0);
});

test("GET /batches lists with counts; GET /batches/:id returns contacts with preview; bad id -> 400/404", async () => {
  const up = await upload({ name: "listing" });
  const list = await c.get("/api/batches");
  assert.equal(list.status, 200);
  const item = list.json.batches.find((b) => b.id === up.json.batch.id);
  assert.equal(item.contactCount, 5);
  assert.equal(item.name, "listing");
  const one = await c.get(`/api/batches/${up.json.batch.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.contacts.length, 5);
  assert.ok(one.json.contacts[0].preview.text);
  assert.equal((await c.get("/api/batches/not-a-uuid")).status, 400);
  assert.equal((await c.get("/api/batches/00000000-0000-4000-8000-000000000000")).status, 404);
});

test("GET /contacts: filters, search, pagination, validation", async () => {
  const a = (await upload({ name: "pg-a" })).json;
  await t.pool.query("update contacts set status='sent' where id=$1", [a.contacts[0].id]);
  let r = await c.get(`/api/contacts?batchId=${a.batch.id}&pageSize=2&page=1`);
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 5);
  assert.equal(r.json.contacts.length, 2);
  assert.equal(r.json.page, 1);
  assert.equal(r.json.pageSize, 2);
  r = await c.get(`/api/contacts?batchId=${a.batch.id}&pageSize=2&page=3`);
  assert.equal(r.json.contacts.length, 1);
  r = await c.get(`/api/contacts?batchId=${a.batch.id}&status=sent`);
  assert.equal(r.json.total, 1);
  assert.equal(r.json.contacts[0].id, a.contacts[0].id);
  r = await c.get(`/api/contacts?batchId=${a.batch.id}&q=FABRIKAM`);
  assert.equal(r.json.total, 1);
  r = await c.get(`/api/contacts?batchId=${a.batch.id}&q=${encodeURIComponent("100%_")}`);
  assert.equal(r.json.total, 0); // LIKE wildcards are escaped
  for (const bad of ["status=bogus", "page=0", "pageSize=1000", "batchId=x", "unknown=1", "q=" + "a".repeat(300)]) {
    assert.equal((await c.get(`/api/contacts?${bad}`)).status, 400, bad);
  }
  r = await c.get("/api/contacts?q=%27%3B%20drop%20table%20contacts%3B--");
  assert.equal(r.status, 200);
});

test("opt-out: creates suppression, cancels pending messages, sets status, writes events", async () => {
  const up = (await upload({ name: "optout" })).json;
  const id = up.contacts[1].id;
  const email = up.contacts[1].email;
  await t.pool.query("update contacts set status='scheduled' where id=$1", [id]);
  await t.pool.query(
    "insert into messages(contact_id, kind, state, scheduled_for) values($1,'initial','scheduled', now()+interval '1 day'),($1,'followup','scheduled', now()+interval '8 days')",
    [id],
  );
  const r = await c.post(`/api/contacts/${id}/opt-out`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.contact.status, "opted_out");
  const sup = await t.pool.query("select reason from suppressions where email=$1", [email]);
  assert.equal(sup.rowCount, 1);
  assert.equal(await count("select count(*) n from messages where contact_id=$1 and state='cancelled'", [id]), 2);
  assert.equal(await count("select count(*) n from events where contact_id=$1 and type='opted_out'", [id]), 1);
  // idempotent
  assert.equal((await c.post(`/api/contacts/${id}/opt-out`, {})).status, 200);
  // suppression applies across batches on later imports
  const again = await upload({ content: Buffer.from(`${H}\n${line(email.toUpperCase())}`) });
  assert.equal(again.status, 422);
  // other contacts of the same address in other batches are also stopped
  assert.equal((await c.post("/api/contacts/00000000-0000-4000-8000-000000000000/opt-out", {})).status, 404);
  assert.equal((await c.post("/api/contacts/nope/opt-out", {})).status, 400);
});

test("opt-out also stops other pending contacts that share the email", async () => {
  const a = (await upload({ content: Buffer.from(`${H}\n${line("shared@example.com")}`) })).json.contacts[0];
  const b = (await upload({ content: Buffer.from(`${H}\n${line("shared@example.com")}`) })).json.contacts[0];
  await t.pool.query("insert into messages(contact_id, kind, state, scheduled_for) values($1,'initial','scheduled', now()+interval '1 day')", [b.id]);
  await t.pool.query("update contacts set status='scheduled' where id=$1", [b.id]);
  await c.post(`/api/contacts/${a.id}/opt-out`, {});
  assert.equal(await count("select count(*) n from messages where contact_id=$1 and state='cancelled'", [b.id]), 1);
  assert.equal((await t.pool.query("select status from contacts where id=$1", [b.id])).rows[0].status, "opted_out");
});

test("mark-replied: status, replied_at, cancels pending messages (incl. follow-up), event written", async () => {
  const up = (await upload({ name: "replied" })).json;
  const id = up.contacts[2].id;
  await t.pool.query("update contacts set status='sent' where id=$1", [id]);
  await t.pool.query(
    "insert into messages(contact_id, kind, state, scheduled_for, sent_at) values($1,'initial','sent', now()-interval '1 day', now()-interval '1 day')",
    [id],
  );
  await t.pool.query("insert into messages(contact_id, kind, state, scheduled_for) values($1,'followup','scheduled', now()+interval '6 days')", [id]);
  const r = await c.post(`/api/contacts/${id}/mark-replied`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.contact.status, "replied");
  assert.ok(r.json.contact.repliedAt);
  assert.equal(await count("select count(*) n from messages where contact_id=$1 and kind='followup' and state='cancelled'", [id]), 1);
  assert.equal(await count("select count(*) n from messages where contact_id=$1 and kind='initial' and state='sent'", [id]), 1);
  assert.equal(await count("select count(*) n from events where contact_id=$1 and type='replied'", [id]), 1);
  assert.equal((await c.post("/api/contacts/00000000-0000-4000-8000-000000000000/mark-replied", {})).status, 404);
});

test("a message currently 'sending' is not cancelled by opt-out (never fight an in-flight send)", async () => {
  const up = (await upload({ content: Buffer.from(`${H}\n${line("inflight@example.com")}`) })).json;
  const id = up.contacts[0].id;
  await t.pool.query("insert into messages(contact_id, kind, state, scheduled_for) values($1,'initial','sending', now())", [id]);
  await c.post(`/api/contacts/${id}/opt-out`, {});
  assert.equal(await count("select count(*) n from messages where contact_id=$1 and state='sending'", [id]), 1);
});

test("errors never leak SQL or stack", async () => {
  const r = await c.get("/api/contacts?page=abc");
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /select|stack|at \w+ \(/i);
});

test("mark-replied clears followup_requested and is idempotent (one event, replied_at stable)", async () => {
  const up = (await upload({ content: Buffer.from(`${H}\n${line("idem@example.com")}`) })).json;
  const id = up.contacts[0].id;
  await t.pool.query("update contacts set status='sent', followup_requested=true where id=$1", [id]);
  const first = await c.post(`/api/contacts/${id}/mark-replied`, {});
  assert.equal(first.status, 200);
  assert.equal(first.json.contact.followupRequested, false);
  assert.equal((await t.pool.query("select followup_requested f from contacts where id=$1", [id])).rows[0].f, false);
  const second = await c.post(`/api/contacts/${id}/mark-replied`, {});
  assert.equal(second.status, 200);
  assert.equal(second.json.contact.status, "replied");
  assert.equal(second.json.contact.repliedAt, first.json.contact.repliedAt);
  assert.equal(await count("select count(*) n from events where contact_id=$1 and type='replied'", [id]), 1);
});

test("cross-batch duplicate email is imported with a warning carrying the existing status; warnings is [] otherwise", async () => {
  const first = await upload({ content: Buffer.from(`${H}\n${line("cross@example.com")}`) });
  assert.deepEqual(first.json.warnings, []);
  await t.pool.query("update contacts set status='replied' where id=$1", [first.json.contacts[0].id]);
  const r = await upload({ content: Buffer.from(`${H}\n${line("fresh-x@example.com")}\n${line("CROSS@example.com")}`) });
  assert.equal(r.status, 201);
  assert.equal(r.json.contacts.length, 2);
  assert.deepEqual(r.json.errors, []);
  assert.equal(r.json.warnings.length, 1);
  assert.equal(r.json.warnings[0].row, 3);
  assert.equal(r.json.warnings[0].existingStatus, "replied");
  assert.match(r.json.warnings[0].message, /already in another batch \(status: replied\)/);
});
