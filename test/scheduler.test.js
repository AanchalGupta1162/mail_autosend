import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJobs } from "../src/scheduler.js";

const OPTS = { followUpIntervalDays: 7, followUpMaxCount: 3 };
const NOW = new Date("2026-01-15T09:00:00Z");

function row(overrides) {
  return {
    rowNumber: 2,
    company: "Acme",
    role: "Engineer",
    person: "Jane",
    email: "jane@acme.com",
    subject: "Hi",
    mailText: "Hello",
    followUpText: "Bumping this",
    status: "",
    messageId: null,
    lastSentAt: null,
    followUpCount: 0,
    ...overrides,
  };
}

test("a never-sent row gets an initial job", () => {
  const { jobs, doneUpdates } = buildJobs([row({ status: "" })], { ...OPTS, now: NOW });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "initial");
  assert.equal(doneUpdates.length, 0);
});

test("a Sent row not yet due for follow-up produces no job", () => {
  const lastSentAt = new Date("2026-01-12T09:00:00Z"); // 3 days ago, interval is 7
  const { jobs, doneUpdates } = buildJobs([row({ status: "Sent", lastSentAt, followUpCount: 0 })], {
    ...OPTS,
    now: NOW,
  });
  assert.equal(jobs.length, 0);
  assert.equal(doneUpdates.length, 0);
});

test("a Sent row due for follow-up produces a followup job with the right number", () => {
  const lastSentAt = new Date("2026-01-08T09:00:00Z"); // 7 days ago
  const { jobs } = buildJobs([row({ status: "Sent", lastSentAt, followUpCount: 0 })], { ...OPTS, now: NOW });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "followup");
  assert.equal(jobs[0].followUpNumber, 1);
});

test("a Sent row with no follow-up text is never followed up, even if due", () => {
  const lastSentAt = new Date("2026-01-01T09:00:00Z"); // way overdue
  const { jobs } = buildJobs([row({ status: "Sent", lastSentAt, followUpCount: 0, followUpText: "" })], {
    ...OPTS,
    now: NOW,
  });
  assert.equal(jobs.length, 0);
});

test("a row that hit the max follow-up count with no reply is marked Done, not re-sent", () => {
  const lastSentAt = new Date("2026-01-01T09:00:00Z");
  const { jobs, doneUpdates } = buildJobs([row({ status: "Sent", lastSentAt, followUpCount: 3 })], {
    ...OPTS,
    now: NOW,
  });
  assert.equal(jobs.length, 0);
  assert.equal(doneUpdates.length, 1);
});

test("Replied, Done, and Failed rows are left alone entirely", () => {
  const lastSentAt = new Date("2026-01-01T09:00:00Z");
  const rows = [
    row({ status: "Replied", lastSentAt }),
    row({ status: "Done", lastSentAt, followUpCount: 3 }),
    row({ status: "Failed", lastSentAt }),
  ];
  const { jobs, doneUpdates } = buildJobs(rows, { ...OPTS, now: NOW });
  assert.equal(jobs.length, 0);
  assert.equal(doneUpdates.length, 0);
});
