import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { classifySendError } from "../../src/worker/classify.js";
import { startFakeSmtp, closedPort, realError } from "../helpers/smtp.js";

const out = (err) => classifySendError(err).outcome;
const e = (props) => Object.assign(new Error(props.message ?? "boom"), props);

// These shapes come from real nodemailer 6.x talking to a scripted local SMTP server.
let srv;
before(async () => {
  srv = await startFakeSmtp("ok");
});
after(async () => srv?.close());

test("REAL: connection refused (nothing listening) is retryable", async () => {
  const port = await closedPort();
  const err = await realError(nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }));
  assert.equal(err.command, "CONN");
  assert.equal(out(err), "retry");
});

test("REAL: server drops the socket after accepting DATA is AMBIGUOUS, not retryable", async () => {
  srv.setMode("die-after-data");
  const err = await realError(srv.transport());
  assert.equal(err.command, "CONN"); // nodemailer tags post-DATA socket loss as CONN
  assert.equal(err.code, "ECONNECTION");
  assert.equal(srv.state.dataConnections > 0, true);
  assert.equal(out(err), "ambiguous");
});

test("REAL: RCPT TO 550 is permanent", async () => {
  srv.setMode("reject-rcpt");
  const err = await realError(srv.transport());
  assert.equal(err.command, "RCPT TO");
  assert.equal(out(err), "permanent");
});

test("connect-time proofs retry; the same codes without proof are ambiguous", () => {
  assert.equal(out(e({ code: "EDNS", command: "CONN" })), "retry");
  assert.equal(out(e({ code: "ETIMEDOUT", command: "CONN", message: "Connection timeout" })), "retry");
  assert.equal(out(e({ code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" })), "retry");
  assert.equal(out(e({ code: "ESOCKET", command: "CONN", syscall: "connect", message: "connect ECONNREFUSED 1.2.3.4:25" })), "retry");
  assert.equal(out(e({ code: "ESOCKET", command: "CONN", syscall: "connect", message: "connect EHOSTUNREACH 1.2.3.4:25" })), "retry");
  assert.equal(out(e({ code: "ESOCKET", command: "CONN", syscall: "connect", message: "getaddrinfo ENOTFOUND smtp.x" })), "retry");
  // post-DATA shapes nodemailer really emits (all tagged CONN):
  assert.equal(out(e({ code: "ETIMEDOUT", command: "CONN", message: "Socket timeout" })), "ambiguous");
  assert.equal(out(e({ code: "ESOCKET", command: "CONN", message: "read ECONNRESET" })), "ambiguous");
  assert.equal(out(e({ code: "ECONNECTION", command: "CONN", message: "Connection closed unexpectedly" })), "ambiguous");
  assert.equal(out(e({ code: "ECONNECTION", command: "CONN", message: "Connection closed", response: "250 OK queued", responseCode: 250 })), "ambiguous");
  assert.equal(out(e({ code: "EPROTOCOL", command: "CONN" })), "ambiguous");
});

test("pre-DATA SMTP rejections: 4xx retry, 5xx on MAIL/RCPT permanent, credential/config errors hold", () => {
  // Not the message's fault and retrying will not help: hold the queue instead of burning attempts.
  assert.equal(out(e({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 454 })), "hold");
  assert.equal(out(e({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 })), "hold");
  assert.equal(out(e({ code: "EAUTH", command: "AUTH LOGIN" })), "hold");
  assert.equal(out(e({ code: "EAUTH" })), "hold");
  assert.equal(out(e({ code: "EENVELOPE", command: "RCPT TO", responseCode: 450 })), "retry");
  assert.equal(out(e({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 })), "permanent");
  assert.equal(out(e({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 553 })), "permanent");
  assert.equal(out(e({ code: "EPROTOCOL", command: "EHLO", responseCode: 421 })), "retry");
  assert.equal(out(e({ code: "EPROTOCOL", command: "STARTTLS", responseCode: 454 })), "retry");
  assert.equal(out(e({ code: "ENOENT" })), "hold"); // attachment/signature missing, nothing sent
  assert.equal(out(e({ code: "EACCES" })), "hold");
});

test("anything with a 2xx/3xx response, a DATA command, or unknown shape is ambiguous", () => {
  assert.equal(out(e({ code: "EPROTOCOL", command: "RCPT TO", responseCode: 250 })), "ambiguous");
  assert.equal(out(e({ code: "EMESSAGE", command: "DATA", responseCode: 554 })), "ambiguous");
  assert.equal(out(e({ code: "ETIMEDOUT", command: "DATA" })), "ambiguous");
  assert.equal(out(e({ code: "ECONNRESET", command: "RCPT TO" })), "ambiguous");
  assert.equal(out(e({ code: "ECONNRESET" })), "ambiguous");
  assert.equal(out(e({ code: "ESENDTIMEOUT" })), "ambiguous");
  assert.equal(out(new Error("something odd")), "ambiguous");
  assert.equal(out(null), "ambiguous");
  assert.equal(out("string error"), "ambiguous");
});

test("result carries a short, control-free description", () => {
  const r = classifySendError(e({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535, message: "Invalid login\r\nline2" }));
  assert.match(r.description, /EAUTH/);
  assert.doesNotMatch(r.description, /[\r\n]/);
  assert.ok(r.description.length <= 240);
});
