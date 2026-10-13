import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestDb } from "../helpers/db.js";
import { seedBatch, addMessage } from "../helpers/seed.js";
import { startFakeSmtp } from "../helpers/smtp.js";
import { runTick } from "../../src/worker/tick.js";
import { startTestApp } from "../helpers/app.js";

const SIGNATURE = path.resolve("signature.html");
const RESUME = path.resolve("attachments/Harshavardhan_Khamkar_Resume_.pdf");
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
  await pool.query("TRUNCATE batches, suppressions, events RESTART IDENTITY CASCADE");
});

// Quoted-printable decode so assertions see the real HTML.
const decode = (raw) => raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const tick = () => runTick({ pool, mailer: smtp.transport(), config, sleep: async () => {}, logger: silent });

function assertSignedWithResume(raw) {
  const body = decode(raw);
  assert.match(body, /Content-Type: text\/html/i);
  assert.ok(body.includes("github.com/Harshavardhan-28"), "signature html is in the body");
  assert.ok(body.includes("<strong>Harshavardhan Khamkar</strong>"), "signature name is in the body");
  assert.match(body, /Content-Disposition: attachment;\s*filename=("?)Harshavardhan_Khamkar_Resume_\.pdf/i, "resume is attached");
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
    assert.match(r.json.contacts[0].preview.text, /Harshavardhan Khamkar/);
    assert.match(r.json.contacts[0].preview.text, /Regards,/);
  } finally {
    await t.close();
  }
});
