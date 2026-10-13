import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "../helpers/app.js";

let t, c;
before(async () => {
  t = await startTestApp({ SEND_WINDOW_ENFORCED: "true" });
  await t.addUser("admin");
  c = t.client();
  await c.login();
});
after(async () => t?.close());

const put = (body, cl = c, o = {}) => cl.raw("PUT", "/api/settings/send-window", { body, ...o });
const W = { start: "09:00", end: "10:00", tz: "Asia/Kolkata" };

test("send-window routes require auth and CSRF", async () => {
  const anon = t.client();
  assert.equal((await anon.get("/api/settings/send-window")).status, 401);
  assert.equal((await anon.raw("PUT", "/api/settings/send-window", { body: W })).status, 401);
  const noCsrf = t.client();
  await noCsrf.login();
  assert.equal((await put(W, noCsrf, { csrf: false })).status, 403);
});

test("GET returns the default window and whether it is enforced", async () => {
  const r = await c.get("/api/settings/send-window");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { enforced: true, window: W });
});

test("PUT stores a valid window and GET reflects it", async () => {
  const w = { start: "08:15", end: "09:45", tz: "UTC" };
  const r = await put(w);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { enforced: true, window: w });
  assert.deepEqual((await c.get("/api/settings/send-window")).json.window, w);
});

test("PUT rejects bad input with 400 and leaves the stored window alone", async () => {
  const before = (await c.get("/api/settings/send-window")).json.window;
  for (const bad of [
    { start: "9:00", end: "10:00", tz: "UTC" },
    { start: "10:00", end: "09:00", tz: "UTC" },
    { start: "09:00", end: "09:00", tz: "UTC" },
    { start: "09:00", end: "10:00", tz: "Nowhere/Land" },
    { start: "09:00", end: "10:00", tz: "UTC", x: 1 },
    { start: "09:00", end: "10:00" },
    {},
  ]) {
    const r = await put(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(typeof r.json.error === "string");
  }
  assert.deepEqual((await c.get("/api/settings/send-window")).json.window, before);
});

test("enforced is false when SEND_WINDOW_ENFORCED is unset", async () => {
  const t2 = await startTestApp();
  try {
    await t2.addUser("admin");
    const c2 = t2.client();
    await c2.login();
    assert.equal((await c2.get("/api/settings/send-window")).json.enforced, false);
  } finally {
    await t2.close();
  }
});
