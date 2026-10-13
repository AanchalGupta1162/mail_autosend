import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSendAt, planStagger, MAX_DAYS_AHEAD } from "../../src/domain/schedule.js";

const now = new Date("2026-10-12T10:00:00.000Z");
const rejects = (v) => assert.throws(() => validateSendAt(v, now), (e) => e.status === 400);

test("accepts a future ISO instant with offset and returns a Date", () => {
  assert.equal(validateSendAt("2026-10-12T10:00:01Z", now).toISOString(), "2026-10-12T10:00:01.000Z");
  assert.equal(validateSendAt("2026-10-13T09:00:00+05:30", now).toISOString(), "2026-10-13T03:30:00.000Z");
});

test("rejects past, now, malformed, non-string and calendar-invalid values", () => {
  for (const v of ["2026-10-12T10:00:00Z", "2020-01-01T00:00:00Z", "tomorrow", "", "2026-10-13", "2026-10-13T10:00:00", "2026-02-31T10:00:00Z", "2026-13-01T10:00:00Z", 1789000000000, null, undefined, {}, "2026-10-13T10:00:00Zjunk"]) rejects(v);
});

test("rejects more than 90 days out; accepts exactly 90", () => {
  assert.equal(MAX_DAYS_AHEAD, 90);
  const edge = new Date(now.getTime() + 90 * 86400_000);
  assert.equal(validateSendAt(edge.toISOString(), now).getTime(), edge.getTime());
  rejects(new Date(edge.getTime() + 1).toISOString());
});

test("stagger spaces N minutes in order", () => {
  const start = new Date("2026-10-13T09:00:00Z");
  assert.deepEqual(planStagger(start, 3, 15).map((d) => d.toISOString()), ["2026-10-13T09:00:00.000Z", "2026-10-13T09:15:00.000Z", "2026-10-13T09:30:00.000Z"]);
  assert.deepEqual(planStagger(start, 2, 0).map((d) => d.getTime()), [start.getTime(), start.getTime()]);
});
