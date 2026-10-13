import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMail } from "../../src/worker/send.js";

const contact = { email: "a@x.com", person: "Jo Smith", role: "SWE", company: "Acme", followup_text: null, subject: "SWE role at Acme", mail_text: "Hi" };
const followup = (subject, template) =>
  buildMail({
    config: { gmailUser: "me@gmail.com" },
    signatureHtml: "",
    contact: { ...contact, subject },
    message: { kind: "followup", message_id: "<f@x>" },
    initialMessageId: "<i@x>",
    template: template ?? { subject: "Re: {{subject}}", body: "Hi {{firstName}}" },
  });

test("follow-up subject has exactly one Re: prefix, whatever the original or template says", () => {
  assert.equal(followup("SWE role at Acme").subject, "Re: SWE role at Acme");
  assert.equal(followup("Re: SWE role at Acme").subject, "Re: SWE role at Acme");
  assert.equal(followup("RE:   re: SWE role at Acme").subject, "Re: SWE role at Acme");
  assert.equal(followup("SWE role", { subject: "Checking in: {{subject}}", body: "x" }).subject, "Re: Checking in: SWE role");
});

test("follow-up is threaded on the initial's Message-ID", () => {
  const m = followup("x");
  assert.equal(m.inReplyTo, "<i@x>");
  assert.equal(m.references, "<i@x>");
  assert.equal(m.messageId, "<f@x>");
});
