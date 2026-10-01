import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDelayMs, processQueue } from "../src/queue.js";

test("computeDelayMs returns 0 for 0 or 1 pending rows", () => {
  assert.equal(computeDelayMs(60, 0), 0);
  assert.equal(computeDelayMs(60, 1), 0);
});

test("computeDelayMs spreads the window evenly across pending rows", () => {
  // 60 minutes / 10 rows = 6 minutes = 360000ms
  assert.equal(computeDelayMs(60, 10), 360000);
});

test("computeDelayMs never goes below the minimum delay", () => {
  // 60 minutes / 1000 rows would be 3.6s, below the 5s floor
  assert.equal(computeDelayMs(60, 1000), 5000);
});

test("processQueue calls sendOne for every row in order", async () => {
  const seen = [];
  await processQueue([{ id: 1 }, { id: 2 }, { id: 3 }], 0, async (row) => {
    seen.push(row.id);
  });
  assert.deepEqual(seen, [1, 2, 3]);
});

test("processQueue continues even if sendOne throws", async () => {
  const seen = [];
  await processQueue([{ id: 1 }, { id: 2 }], 0, async (row) => {
    seen.push(row.id);
    if (row.id === 1) throw new Error("boom");
  });
  assert.deepEqual(seen, [1, 2]);
});
