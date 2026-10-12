import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoller } from "../../src/worker/poller.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {
  const lines = [];
  return { lines, error: (...a) => lines.push(a.join(" ")), info() {}, warn() {} };
};

test("runs the tick repeatedly and never overlaps itself", async () => {
  let active = 0, max = 0, runs = 0;
  const p = createPoller({
    intervalMs: 5,
    logger: quiet(),
    run: async () => {
      active++; max = Math.max(max, active); runs++;
      await wait(30);
      active--;
    },
  });
  p.start();
  await wait(200);
  await p.stop();
  assert.ok(runs >= 2, `runs=${runs}`);
  assert.equal(max, 1);
});

test("errors are logged without message text and do not stop the loop", async () => {
  const logger = quiet();
  let runs = 0;
  const p = createPoller({
    intervalMs: 5,
    logger,
    run: async () => {
      runs++;
      throw Object.assign(new Error("password=hunter2 postgres://u:p@h/db"), { code: "XYZ" });
    },
  });
  p.start();
  await wait(80);
  await p.stop();
  assert.ok(runs >= 2);
  assert.ok(logger.lines.length >= 1);
  assert.doesNotMatch(logger.lines.join("\n"), /hunter2|postgres:/);
  assert.match(logger.lines[0], /XYZ/);
});

test("stop waits for the in-flight tick and prevents further ticks; start is idempotent", async () => {
  let runs = 0, finished = 0;
  const p = createPoller({ intervalMs: 5, logger: quiet(), run: async () => { runs++; await wait(60); finished++; } });
  p.start();
  p.start();
  await wait(20);
  await p.stop();
  assert.equal(finished, runs, "in-flight tick completed before stop resolved");
  const after = runs;
  await wait(50);
  assert.equal(runs, after);
  await p.stop(); // idempotent
});
