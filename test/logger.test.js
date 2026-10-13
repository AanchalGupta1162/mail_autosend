import { test } from "node:test";
import assert from "node:assert/strict";
import { createJsonLogger } from "../src/logger.js";

test("emits one-line JSON with Cloud Logging severity and message; errors go to stderr", () => {
  const out = [], err = [];
  const log = createJsonLogger({ out: (l) => out.push(l), err: (l) => err.push(l) });
  log.info("hello", { event: "e", n: 2 });
  log.warn("careful");
  log.error("boom\nsecond line");
  assert.deepEqual(JSON.parse(out[0]), { severity: "INFO", message: "hello", event: "e", n: 2 });
  assert.equal(JSON.parse(err[0]).severity, "WARNING");
  const e = JSON.parse(err[1]);
  assert.equal(e.severity, "ERROR");
  assert.equal(e.message, "boom\nsecond line");
  assert.ok(![...out, ...err].some((l) => l.includes("\n")), "each entry is a single line");
});

test("reserved keys cannot be overridden by fields", () => {
  const out = [];
  const log = createJsonLogger({ out: (l) => out.push(l) });
  log.info("m", { severity: "CRITICAL", message: "spoof" });
  assert.deepEqual(JSON.parse(out[0]), { severity: "INFO", message: "m" });
});
