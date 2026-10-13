import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { startFakeSmtp } from "../helpers/smtp.js";
import { runTick } from "../../src/worker/tick.js";
import { startTestApp } from "../helpers/app.js";

const SIGNATURE = path.resolve("test/fixtures/sig-fixture.html");
const RESUME = path.resolve("test/fixtures/resume.pdf");
const silent = { error() {}, warn() {}, info() {} };
const config = {
  dryRun: false, dailySendCap: 100, maxPerTick: 5, sendGapSecondsMin: 0, sendGapSecondsMax: 0,
  gmailUser: "me@example.com", fromName: "Harsh", signaturePath: SIGNATURE, resumePath: RESUME,
};

let db, pool, smtp;
before(async () => {
  db = await createTestDb();
  pool = db.pool;
  smtp = await startFakeSmtp("ok");
});
after(async () => {
  await smtp?.close();
  await db?.close();
});
beforeEach(async () => {
  smtp.state.bodies.length = 0;
  smtp.state.dataConnections = 0;
  await pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
});

// Quoted-printable decode so assertions see the real HTML.
const decode = (raw) => raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const tick = () => runTick({ pool, mailer: smtp.transport(), config, sleep: async () => {}, logger: silent });

function assertSignedWithResume(raw) {
  const body = decode(raw);
  assert.match(body, /Content-Type: text\/html/i);
  assert.ok(body.includes("example.com/portfolio-fixture"), "signature html is in the body");
  assert.ok(body.includes("<strong>Test Signer</strong>"), "signature name is in the body");
  assert.match(body, /Content-Disposition: attachment;\s*filename=("?)resume\.pdf/i, "resume is attached");
  assert.match(body, /application\/pdf/i);
}

test("real send path: initial mail carries the signature HTML and the resume PDF", async () => {
  const email = "sig1@example.com";
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "scheduled" } } });
  await addMessage(pool, contacts[0].id, {});
  const out = await tick();
  assert.equal(out.sent, 1);
  assert.equal(smtp.state.bodies.length, 1);
  assertSignedWithResume(smtp.state.bodies[0]);
});

test("real send path: follow-up mail also carries the signature HTML and the resume PDF", async () => {
  const email = "sig2@example.com";
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "sent", followup_requested: true } } });
  await addMessage(pool, contacts[0].id, { state: "sent", sentAt: new Date(Date.now() - 864e5), messageId: "<i@x>" });
  await addMessage(pool, contacts[0].id, { kind: "followup" });
  const out = await tick();
  assert.equal(out.sent, 1);
  assertSignedWithResume(smtp.state.bodies[0]);
});

test("the batch preview endpoint shows the signature", async () => {
  const t = await startTestApp({ SIGNATURE_PATH: SIGNATURE });
  try {
    await t.addUser("admin");
    const c = t.client();
    await c.login();
    const f = new FormData();
    const csv = '"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"\n"Acme","SWE","Jo","jo@acme.example.com","S","Hi Jo,\n\nHello.","" \n';
    f.append("file", new Blob([csv], { type: "text/csv" }), "l.csv");
    const r = await c.raw("POST", "/api/batches", { rawBody: f });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.contacts[0].preview.text, /Test Signer/);
    assert.match(r.json.contacts[0].preview.text, /Regards,/);
  } finally {
    await t.close();
  }
});

test("real mode: a signature file that vanished after startup holds the queue before SMTP (no attempt consumed); dry-run stays lenient", async () => {
  const email = "sig3@example.com";
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "scheduled" } } });
  const msg = await addMessage(pool, contacts[0].id, {});
  const gone = { ...config, signaturePath: path.resolve("test/fixtures/does-not-exist.html") };
  const out = await runTick({ pool, mailer: smtp.transport(), config: gone, sleep: async () => {}, logger: silent });
  assert.equal(out.sent, 0);
  assert.equal(out.held, 1);
  assert.equal(smtp.state.dataConnections, 0, "nothing reached SMTP");
  const row = (await pool.query("select state, error from messages where id=$1", [msg.id])).rows[0];
  assert.equal(row.state, "scheduled");
  assert.match(row.error, /ENOENT|signature/i);
  assert.equal((await pool.query("select attempts from messages where id=$1", [msg.id])).rows[0].attempts, 0);
  assert.equal((await pool.query("select status from contacts where id=$1", [contacts[0].id])).rows[0].status, "scheduled");

  // dry-run (jsonTransport) is lenient: sends unsigned
  await pool.query("update messages set scheduled_for = now() - interval '1 minute' where id=$1", [msg.id]);
  const dry = await runTick({ pool, mailer: { sendMail: async (o) => ({ messageId: o.messageId }) }, config: { ...gone, dryRun: true }, sleep: async () => {}, logger: silent });
  assert.equal(dry.sent, 1);
});

test("SIGNATURE_HTML wins over SIGNATURE_PATH in the real send path and needs no file", async () => {
  await pool.query("DELETE FROM settings WHERE key = 'send_hold'"); // left by the previous test
  const email = "sig4@example.com";
  const { contacts } = await seedBatch(pool, [email], { overrides: { [email]: { status: "scheduled" } } });
  await addMessage(pool, contacts[0].id, {});
  const inline = { ...config, signatureHtml: "<p>Inline <strong>Signer</strong> sig-inline-marker</p>", signaturePath: path.resolve("test/fixtures/does-not-exist.html") };
  const out = await runTick({ pool, mailer: smtp.transport(), config: inline, sleep: async () => {}, logger: silent });
  assert.equal(out.sent, 1);
  const body = decode(smtp.state.bodies[0]);
  assert.ok(body.includes("sig-inline-marker"));
  assert.ok(!body.includes("Test Signer"), "the file was not used");
});

test("loadSignature prefers config.signatureHtml, then the file", async () => {
  const { loadSignature } = await import("../../src/worker/send.js");
  assert.equal(loadSignature({ signatureHtml: "<i>x</i>", signaturePath: SIGNATURE }), "<i>x</i>");
  assert.match(loadSignature({ signaturePath: SIGNATURE }), /Test Signer/);
  assert.equal(loadSignature({}), "");
});

test("the batch preview endpoint shows SIGNATURE_HTML when set", async () => {
  const t = await startTestApp({ SIGNATURE_HTML: "<p>Inline Preview Signer</p>" });
  try {
    await t.addUser("admin");
    const c = t.client();
    await c.login();
    const f = new FormData();
    const csv = '"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"\n"Acme","SWE","Jo","jo@acme.example.com","S","Hi Jo,\n\nHello.","" \n';
    f.append("file", new Blob([csv], { type: "text/csv" }), "l.csv");
    const r = await c.raw("POST", "/api/batches", { rawBody: f });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.contacts[0].preview.text, /Inline Preview Signer/);
  } finally {
    await t.close();
  }
});
