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

test("an Error as the second argument logs only name and code, never message or stack", () => {
  const out = [], err = [];
  const log = createJsonLogger({ out: (l) => out.push(l), err: (l) => err.push(l) });
  const e = Object.assign(new Error("auth failed for pass=hunter2"), { code: "EAUTH" });
  log.error("send failed", e);
  const line = err[0];
  assert.deepEqual(JSON.parse(line), { severity: "ERROR", message: "send failed", name: "Error", code: "EAUTH" });
  assert.ok(!line.includes("hunter2") && !line.includes("at "), "no message or stack");
  log.warn("dom", { name: "X", code: 5, message: "secret", stack: "s" });
  assert.deepEqual(JSON.parse(err[1]), { severity: "WARNING", message: "dom", name: "X", code: 5 });
});
