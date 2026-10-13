import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import { DEFAULT_SEND_WINDOW, isInSendWindow, getSendWindow, putSendWindow, sendWindowSchema, windowLabel } from "../../src/domain/sendWindow.js";

const IST = DEFAULT_SEND_WINDOW; // 09:00-10:00 Asia/Kolkata (UTC+5:30)
// 09:00 IST = 03:30 UTC
const at = (iso) => new Date(iso);

test("default window is 09:00-10:00 Asia/Kolkata", () => {
  assert.deepEqual(IST, { start: "09:00", end: "10:00", tz: "Asia/Kolkata" });
});

test("start is inclusive, end is exclusive (IST)", () => {
  assert.equal(isInSendWindow(IST, at("2026-10-14T03:29:59Z")), false, "08:59:59 IST");
  assert.equal(isInSendWindow(IST, at("2026-10-14T03:30:00Z")), true, "09:00:00 IST");
  assert.equal(isInSendWindow(IST, at("2026-10-14T03:55:00Z")), true, "09:25 IST");
  assert.equal(isInSendWindow(IST, at("2026-10-14T04:29:59Z")), true, "09:59:59 IST");
  assert.equal(isInSendWindow(IST, at("2026-10-14T04:30:00Z")), false, "10:00:00 IST");
});

test("the same UTC clock time is outside the IST window (tz matters)", () => {
  assert.equal(isInSendWindow(IST, at("2026-10-14T09:30:00Z")), false);
  assert.equal(isInSendWindow({ start: "09:00", end: "10:00", tz: "UTC" }, at("2026-10-14T09:30:00Z")), true);
});

test("DST zones follow local wall-clock time on both sides of a transition", () => {
  const ny = { start: "09:00", end: "10:00", tz: "America/New_York" };
  assert.equal(isInSendWindow(ny, at("2026-01-15T14:30:00Z")), true, "winter: 09:30 EST = 14:30Z");
  assert.equal(isInSendWindow(ny, at("2026-07-15T13:30:00Z")), true, "summer: 09:30 EDT = 13:30Z");
  assert.equal(isInSendWindow(ny, at("2026-07-15T14:30:00Z")), false, "summer: 10:30 EDT");
});

test("midnight renders as hour 0, not 24", () => {
  const w = { start: "00:00", end: "01:00", tz: "UTC" };
  assert.equal(isInSendWindow(w, at("2026-10-14T00:00:00Z")), true);
  assert.equal(isInSendWindow(w, at("2026-10-14T01:00:00Z")), false);
});

test("sendWindowSchema: HH:MM, IANA tz, start before end, strict", () => {
  assert.deepEqual(sendWindowSchema.parse({ start: "08:30", end: "11:45", tz: "UTC" }), { start: "08:30", end: "11:45", tz: "UTC" });
  for (const bad of [
    { start: "9:00", end: "10:00", tz: "UTC" },
    { start: "09:00", end: "24:00", tz: "UTC" },
    { start: "09:60", end: "10:00", tz: "UTC" },
    { start: "10:00", end: "10:00", tz: "UTC" },
    { start: "11:00", end: "09:00", tz: "UTC" },
    { start: "09:00", end: "10:00", tz: "Mars/Olympus" },
    { start: "09:00", end: "10:00", tz: "" },
    { start: "09:00", end: "10:00" },
    { start: "09:00", end: "10:00", tz: "UTC", extra: 1 },
  ]) {
    assert.equal(sendWindowSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("windowLabel", () => {
  assert.equal(windowLabel(IST), "09:00–10:00 Asia/Kolkata");
});

let db;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db?.close();
});

test("getSendWindow falls back to the default; put/get round-trips; a corrupt stored value falls back", async () => {
  assert.deepEqual(await getSendWindow(db.pool), IST);
  const w = { start: "08:00", end: "09:30", tz: "UTC" };
  assert.deepEqual(await putSendWindow(db.pool, w), w);
  assert.deepEqual(await getSendWindow(db.pool), w);
  await db.pool.query("UPDATE settings SET value = '{\"start\":\"zz\"}'::jsonb WHERE key = 'send_window'");
  assert.deepEqual(await getSendWindow(db.pool), IST);
});
