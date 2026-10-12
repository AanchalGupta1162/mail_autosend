import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFollowup, DEFAULT_TEMPLATE } from "../../src/domain/template.js";

const contact = { person: "Jo Smith", role: "SWE", company: "Acme", subject: "SWE at Acme", followupText: null };

test("default template renders the documented placeholders", () => {
  const r = renderFollowup(contact, DEFAULT_TEMPLATE);
  assert.equal(r.subject, "Re: SWE at Acme");
  assert.match(r.text, /^Hi Jo,\n\nJust following up on my note about the SWE role at Acme\./);
});

test("values are inserted as plain text: no HTML, no re-expansion of placeholders", () => {
  const evil = { ...contact, company: "<img src=x onerror=1>{{person}}", role: "{{company}}" };
  const r = renderFollowup(evil, { subject: "Re: {{subject}}", body: "{{company}} / {{role}}" });
  assert.equal(r.text, "<img src=x onerror=1>{{person}} / {{company}}");
});

test("unknown placeholders become empty; whitespace inside braces tolerated", () => {
  const r = renderFollowup(contact, { subject: "S{{nope}}", body: "a{{ nope }}b{{ firstName }}{{constructor}}{{__proto__}}" });
  assert.equal(r.subject, "S");
  assert.equal(r.text, "abJo");
});

test("CR/LF can never reach the subject", () => {
  const r = renderFollowup({ ...contact, subject: "x\r\nBcc: a@b.c" }, { subject: "Re: {{subject}}", body: "b" });
  assert.doesNotMatch(r.subject, /[\r\n]/);
});

test("contact followupText replaces the template body", () => {
  const r = renderFollowup({ ...contact, followupText: "Custom follow-up for {{company}}" }, DEFAULT_TEMPLATE);
  assert.equal(r.text, "Custom follow-up for {{company}}");
  assert.equal(r.subject, "Re: SWE at Acme");
});

test("single-word and empty person give a safe firstName", () => {
  assert.equal(renderFollowup({ ...contact, person: "Priya" }, { subject: "s", body: "{{firstName}}" }).text, "Priya");
  assert.equal(renderFollowup({ ...contact, person: "  " }, { subject: "s", body: "[{{firstName}}]" }).text, "[]");
});
