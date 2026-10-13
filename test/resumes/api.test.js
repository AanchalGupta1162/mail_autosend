import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startTestApp } from "../helpers/app.js";
import { seedBatch, addMessage } from "../helpers/seed.js";

const pdfBytes = (tag = "x", extra = 0) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`), Buffer.alloc(extra, 0x20)]);
let t, c, dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "resume-api-"));
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
  await t.pool.query("UPDATE batches SET resume_id = NULL");
  await t.pool.query("DELETE FROM resumes");
  for (const f of await readdir(dir)) await rm(path.join(dir, f), { force: true });
});

function form({ file, fileName = "resume.pdf", type = "application/pdf", displayName, extra = {} }) {
  const f = new FormData();
  if (displayName !== undefined) f.append("displayName", displayName);
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  if (file !== undefined) f.append("file", new Blob([file], { type }), fileName);
  return f;
}
const upload = (opts, client = c) => client.raw("POST", "/api/resumes", { rawBody: form(opts) });
const ok = async (opts) => {
  const r = await upload(opts);
  assert.equal(r.status, 201, r.text);
  return r.json.resume;
};

test("every resume route needs a session; mutating ones also need the CSRF token", async () => {
  const anon = t.client();
  assert.equal((await anon.get("/api/resumes")).status, 401);
  assert.equal((await upload({ file: pdfBytes(), displayName: "A" }, anon)).status, 401);
  const noCsrf = await c.raw("POST", "/api/resumes", { rawBody: form({ file: pdfBytes(), displayName: "A" }), csrf: false });
  assert.equal(noCsrf.status, 403);
  const r = await ok({ file: pdfBytes(), displayName: "A" });
  assert.equal((await c.raw("PUT", `/api/resumes/${r.id}`, { body: { displayName: "B" }, csrf: false })).status, 403);
  assert.equal((await c.raw("DELETE", `/api/resumes/${r.id}`, { csrf: false })).status, 403);
  assert.equal((await anon.raw("DELETE", `/api/resumes/${r.id}`)).status, 401);
});

test("upload stores the PDF, never leaks storage details, and the first resume becomes the default", async () => {
  const buf = pdfBytes("first");
  const r = await ok({ file: buf, displayName: "  General SWE  ", fileName: "My Resume (final).pdf" });
  assert.equal(r.displayName, "General SWE");
  assert.equal(r.fileName, "My Resume (final).pdf");
  assert.equal(r.sizeBytes, buf.length);
  assert.equal(r.isDefault, true);
  assert.deepEqual(Object.keys(r).sort(), ["createdAt", "displayName", "fileName", "id", "isDefault", "sha256", "sizeBytes", "usage"]);
  assert.equal((await readdir(dir)).length, 1);
  const second = await ok({ file: pdfBytes("second"), displayName: "Backend" });
  assert.equal(second.isDefault, false);
});

test("the server decides by magic bytes: a non-PDF named .pdf is refused, a PDF named .txt is accepted", async () => {
  const fake = await upload({ file: Buffer.from("MZ not a pdf %PDF- later"), displayName: "Fake", fileName: "resume.pdf", type: "application/pdf" });
  assert.equal(fake.status, 400);
  assert.match(fake.json.error, /PDF/);
  assert.equal((await readdir(dir)).length, 0, "nothing stored");
  const real = await upload({ file: pdfBytes(), displayName: "Real", fileName: "notes.txt", type: "text/plain" });
  assert.equal(real.status, 201);
  assert.equal(real.json.resume.fileName, "notes.txt.pdf", "the extension is forced to .pdf, not trusted");
});

test("size limit 5 MB (413), empty file and missing file (400)", async () => {
  const exactly = pdfBytes("max", 5 * 1024 * 1024 - pdfBytes("max").length);
  assert.equal(exactly.length, 5 * 1024 * 1024);
  assert.equal((await upload({ file: exactly, displayName: "Max" })).status, 201);
  const big = await upload({ file: pdfBytes("big", 5 * 1024 * 1024), displayName: "Big" });
  assert.equal(big.status, 413);
  assert.equal((await upload({ file: Buffer.alloc(0), displayName: "Empty" })).status, 400);
  assert.equal((await upload({ displayName: "NoFile" })).status, 400);
  assert.equal((await readdir(dir)).length, 1, "only the 5 MB one is stored");
});

test("display names: required, 1-80 chars, no control characters; unknown fields and duplicates refused", async () => {
  const bad = ["", "   ", "x".repeat(81), "tab\there", "new\nline", "nul\0byte", "rtl\u202Eevil"];
  for (const displayName of bad) assert.equal((await upload({ file: pdfBytes(), displayName })).status, 400, JSON.stringify(displayName));
  assert.equal((await upload({ file: pdfBytes() })).status, 400, "missing displayName");
  assert.equal((await upload({ file: pdfBytes(), displayName: "x".repeat(80) })).status, 201);
  assert.equal((await upload({ file: pdfBytes(), displayName: "Ok", extra: { isDefault: "true" } })).status, 400, "unknown field");
  await ok({ file: pdfBytes(), displayName: "Same Name" });
  const dup = await upload({ file: pdfBytes("again"), displayName: "same name" });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /already/i);
  assert.equal((await readdir(dir)).length, 2, "the refused duplicate left no object behind");
});

test("file names are sanitised: no separators, CR/LF, quotes; always .pdf", async () => {
  const cases = [
    ["../../etc/passwd.pdf", "passwd.pdf"],
    ["C:\\Users\\me\\cv.PDF", "cv.pdf"],
    ['a"b\r\nBcc: x@y.z.pdf', null],
    ["   .hidden", "hidden.pdf"],
    [".pdf", "resume.pdf"],
  ];
  let n = 0;
  for (const [input, expected] of cases) {
    const r = await ok({ file: pdfBytes(String(n)), displayName: `n${n++}`, fileName: input });
    assert.match(r.fileName, /^[\p{L}\p{N} ._()-]+\.pdf$/u, r.fileName);
    assert.doesNotMatch(r.fileName, /[\r\n"\\/]/);
    if (expected) assert.equal(r.fileName, expected);
  }
});

test("GET lists live resumes with the default first and usage counts", async () => {
  const a = await ok({ file: pdfBytes("a"), displayName: "Alpha" });
  const b = await ok({ file: pdfBytes("b"), displayName: "Beta" });
  const { contacts, batchId } = await seedBatch(t.pool, ["u@x.com"]);
  await t.pool.query("UPDATE batches SET resume_id = $1 WHERE id = $2", [b.id, batchId]);
  await t.pool.query("UPDATE contacts SET resume_id = $1 WHERE id = $2", [b.id, contacts[0].id]);
  await t.pool.query("UPDATE contacts SET status = 'scheduled' WHERE id = $1", [contacts[0].id]);
  const m = await addMessage(t.pool, contacts[0].id, {});
  await t.pool.query("UPDATE messages SET resume_id = $1 WHERE id = $2", [b.id, m.id]);
  const r = await c.get("/api/resumes");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resumes.map((x) => x.displayName), ["Alpha", "Beta"]);
  assert.equal(r.json.resumes[0].id, a.id);
  assert.deepEqual(r.json.resumes[0].usage, { pendingMessages: 0, batches: 0, contacts: 0 });
  assert.deepEqual(r.json.resumes[1].usage, { pendingMessages: 1, batches: 1, contacts: 1 });
});

test("PUT renames and moves the default; strict body; 404/400/409", async () => {
  const a = await ok({ file: pdfBytes("a"), displayName: "Alpha" });
  const b = await ok({ file: pdfBytes("b"), displayName: "Beta" });
  const renamed = await c.raw("PUT", `/api/resumes/${b.id}`, { body: { displayName: " Beta 2 " } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.resume.displayName, "Beta 2");
  const def = await c.raw("PUT", `/api/resumes/${b.id}`, { body: { isDefault: true } });
  assert.equal(def.json.resume.isDefault, true);
  const list = (await c.get("/api/resumes")).json.resumes;
  assert.deepEqual(list.map((x) => [x.displayName, x.isDefault]), [["Beta 2", true], ["Alpha", false]]);
  assert.equal((await c.raw("PUT", `/api/resumes/${a.id}`, { body: { displayName: "beta 2" } })).status, 409);
  assert.equal((await c.raw("PUT", `/api/resumes/${a.id}`, { body: {} })).status, 400);
  assert.equal((await c.raw("PUT", `/api/resumes/${a.id}`, { body: { displayName: "x", storageKey: "k" } })).status, 400);
  assert.equal((await c.raw("PUT", `/api/resumes/${a.id}`, { body: { displayName: "a\nb" } })).status, 400);
  assert.equal((await c.raw("PUT", "/api/resumes/not-a-uuid", { body: { displayName: "x" } })).status, 400);
  assert.equal((await c.raw("PUT", "/api/resumes/6b0e3c1e-0000-4000-8000-000000000000", { body: { displayName: "x" } })).status, 404);
  const clear = await c.raw("PUT", `/api/resumes/${b.id}`, { body: { isDefault: false } });
  assert.equal(clear.json.resume.isDefault, false);
});

test("DELETE soft-deletes an unused resume and removes its object", async () => {
  const a = await ok({ file: pdfBytes("a"), displayName: "Alpha" });
  assert.equal((await readdir(dir)).length, 1);
  const r = await c.raw("DELETE", `/api/resumes/${a.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual((await c.get("/api/resumes")).json.resumes, []);
  assert.equal((await readdir(dir)).length, 0);
  const row = (await t.pool.query("SELECT deleted_at, is_default FROM resumes WHERE id = $1", [a.id])).rows[0];
  assert.ok(row.deleted_at);
  assert.equal(row.is_default, false);
  assert.equal((await c.raw("DELETE", `/api/resumes/${a.id}`)).status, 404);
  // the name is free again
  assert.equal((await upload({ file: pdfBytes("a2"), displayName: "Alpha" })).status, 201);
});

test("DELETE is refused with 409 and the count while scheduled/in-flight/needs_review messages use it", async () => {
  const a = await ok({ file: pdfBytes("a"), displayName: "Alpha" });
  const { contacts } = await seedBatch(t.pool, ["p1@x.com", "p2@x.com", "p3@x.com"]);
  for (const [i, state] of ["scheduled", "sending", "needs_review"].entries()) {
    const m = await addMessage(t.pool, contacts[i].id, { state });
    await t.pool.query("UPDATE messages SET resume_id = $1 WHERE id = $2", [a.id, m.id]);
  }
  const r = await c.raw("DELETE", `/api/resumes/${a.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.pendingMessages, 3);
  assert.match(r.json.error, /3/);
  assert.equal((await c.get("/api/resumes")).json.resumes.length, 1);
  assert.equal((await readdir(dir)).length, 1, "object untouched");
});

test("DELETE with only sent history: soft-deleted, the object stays (a later follow-up may still need it), choices cleared", async () => {
  const a = await ok({ file: pdfBytes("a"), displayName: "Alpha" });
  const { contacts, batchId } = await seedBatch(t.pool, ["s@x.com"]);
  const m = await addMessage(t.pool, contacts[0].id, { state: "sent", sentAt: new Date(), messageId: "<m@x>" });
  await t.pool.query("UPDATE messages SET resume_id = $1 WHERE id = $2", [a.id, m.id]);
  await t.pool.query("UPDATE batches SET resume_id = $1 WHERE id = $2", [a.id, batchId]);
  await t.pool.query("UPDATE contacts SET resume_id = $1 WHERE id = $2", [a.id, contacts[0].id]);
  assert.equal((await c.raw("DELETE", `/api/resumes/${a.id}`)).status, 200);
  assert.equal((await readdir(dir)).length, 1);
  assert.equal((await t.pool.query("SELECT resume_id FROM batches WHERE id = $1", [batchId])).rows[0].resume_id, null);
  assert.equal((await t.pool.query("SELECT resume_id FROM contacts WHERE id = $1", [contacts[0].id])).rows[0].resume_id, null);
});
