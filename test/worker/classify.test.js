import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySendError } from "../../src/worker/classify.js";

const e = (props) => Object.assign(new Error("boom"), props);
const out = (err) => classifySendError(err).outcome;

test("failures before DATA is accepted are safe to retry", () => {
  assert.equal(out(e({ code: "ECONNECTION", command: "CONN" })), "retry");
  assert.equal(out(e({ code: "ETIMEDOUT", command: "CONN" })), "retry");
  assert.equal(out(e({ code: "EDNS" })), "retry");
  assert.equal(out(e({ code: "ECONNREFUSED" })), "retry");
  assert.equal(out(e({ code: "ENOTFOUND" })), "retry");
  assert.equal(out(e({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 454 })), "retry");
  assert.equal(out(e({ code: "EPROTOCOL", command: "EHLO" })), "retry");
  assert.equal(out(e({ code: "ESOCKET", command: "STARTTLS" })), "retry");
  assert.equal(out(e({ code: "EENVELOPE", command: "RCPT TO", responseCode: 450 })), "retry");
  assert.equal(out(e({ code: "ENOENT" })), "retry"); // attachment missing: nothing was sent
});

test("permanent rejections of sender/recipient are failed, not retried", () => {
  assert.equal(out(e({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 })), "permanent");
  assert.equal(out(e({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 553 })), "permanent");
  assert.equal(out(e({ command: "RCPT TO", responseCode: 554 })), "permanent");
});

test("anything that may have reached DATA, and anything unknown, is ambiguous", () => {
  assert.equal(out(e({ code: "ETIMEDOUT", command: "DATA" })), "ambiguous");
  assert.equal(out(e({ code: "ESOCKET", command: "DATA" })), "ambiguous");
  assert.equal(out(e({ code: "ECONNRESET" })), "ambiguous");
  assert.equal(out(e({ code: "ETIMEDOUT" })), "ambiguous");
  assert.equal(out(e({ code: "ESOCKET" })), "ambiguous");
  assert.equal(out(e({ code: "EMESSAGE", command: "DATA", responseCode: 554 })), "ambiguous");
  assert.equal(out(e({ code: "ESENDTIMEOUT" })), "ambiguous");
  assert.equal(out(new Error("something odd")), "ambiguous");
  assert.equal(out(null), "ambiguous");
  assert.equal(out("string error"), "ambiguous");
});

test("a socket error while still before DATA (RCPT TO) is safe; the same error without a known command is not", () => {
  assert.equal(out(e({ code: "ECONNRESET", command: "RCPT TO" })), "retry");
  assert.equal(out(e({ code: "ECONNRESET" })), "ambiguous");
});

test("result carries a short, control-free description", () => {
  const r = classifySendError(e({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, message: "Invalid login\r\nline2" }));
  assert.match(r.description, /EAUTH/);
  assert.doesNotMatch(r.description, /[\r\n]/);
  assert.ok(r.description.length <= 240);
});
