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

// The UI needs message ids to cancel/reschedule from the contacts list.
test("GET /contacts lists each contact's non-cancelled messages", async () => {
  const { batchId, contacts } = await seedBatch(t.pool, ["m1@msg.example.com", "m2@msg.example.com"], {
    overrides: { "m1@msg.example.com": { status: "scheduled" } },
  });
  const at = new Date(Date.now() + 3600_000);
  const live = await addMessage(t.pool, contacts[0].id, { state: "scheduled", scheduledFor: at });
  await addMessage(t.pool, contacts[0].id, { kind: "followup", state: "cancelled" });
  const r = await c.get(`/api/contacts?batchId=${batchId}`);
  assert.equal(r.status, 200);
  const byEmail = Object.fromEntries(r.json.contacts.map((x) => [x.email, x]));
  assert.deepEqual(byEmail["m1@msg.example.com"].messages, [
    { id: live.id, kind: "initial", state: "scheduled", scheduledFor: at.toISOString(), sentAt: null },
  ]);
  assert.deepEqual(byEmail["m2@msg.example.com"].messages, []);
});
