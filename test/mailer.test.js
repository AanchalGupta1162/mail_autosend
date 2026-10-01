import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInitialMailOptions, buildFollowUpMailOptions, send } from "../src/mailer.js";

const config = {
  gmailUser: "me@gmail.com",
  signatureHtml: "<div>Jane Doe</div>",
  resumePath: "./attachments/resume-placeholder.txt",
};

const row = {
  email: "recruiter@acme.com",
  subject: "Hello there",
  mailText: "Hi **recruiter**",
  followUpText: "Just **bumping** this",
  messageId: "<original@mail.gmail.com>",
};

test("buildInitialMailOptions attaches the resume and uses the row's subject as-is", () => {
  const options = buildInitialMailOptions(config, row);
  assert.equal(options.to, "recruiter@acme.com");
  assert.equal(options.subject, "Hello there");
  assert.deepEqual(options.attachments, [{ path: config.resumePath }]);
  assert.match(options.html, /<strong>recruiter<\/strong>/);
  assert.equal(options.inReplyTo, undefined);
});

test("buildInitialMailOptions omits attachments when resumePath isn't configured", () => {
  const options = buildInitialMailOptions({ ...config, resumePath: undefined }, row);
  assert.equal(options.attachments, undefined);
});

test("buildFollowUpMailOptions prefixes the subject with Re: and sets threading headers, no attachment", () => {
  const options = buildFollowUpMailOptions(config, row);
  assert.equal(options.subject, "Re: Hello there");
  assert.equal(options.inReplyTo, "<original@mail.gmail.com>");
  assert.equal(options.references, "<original@mail.gmail.com>");
  assert.match(options.html, /<strong>bumping<\/strong>/);
  assert.equal(options.attachments, undefined);
});

test("send resolves to the transport's messageId", async () => {
  const fakeTransport = {
    sendMail: async () => ({ messageId: "<new@mail.gmail.com>" }),
  };
  const messageId = await send(fakeTransport, { to: "x@y.com" });
  assert.equal(messageId, "<new@mail.gmail.com>");
});
