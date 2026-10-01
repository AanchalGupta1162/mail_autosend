import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownBoldToHtml, composeBody } from "../src/compose.js";

test("markdownBoldToHtml converts **bold** to <strong> and escapes HTML", () => {
  const html = markdownBoldToHtml("Hi <Team>, this is **very important** & urgent");
  assert.match(html, /<strong>very important<\/strong>/);
  assert.match(html, /&lt;Team&gt;/);
  assert.match(html, /&amp; urgent/);
});

test("markdownBoldToHtml converts newlines to <br>", () => {
  const html = markdownBoldToHtml("Line one\nLine two");
  assert.match(html, /Line one<br>\nLine two/);
});

test("composeBody appends the signature to both html and text, stripping tags for text", () => {
  const signature = '<div><strong>Jane Doe</strong><br>jane@x.com</div>';
  const { html, text } = composeBody("Hi **there**", signature);
  assert.match(html, /<strong>there<\/strong>/);
  assert.match(html, /<strong>Jane Doe<\/strong>/);
  assert.match(text, /Hi there/);
  assert.match(text, /Jane Doe/);
  assert.doesNotMatch(text, /<[^>]+>/);
});

test("composeBody with no signature just returns the body", () => {
  const { html, text } = composeBody("Hi **there**", "");
  assert.match(html, /<strong>there<\/strong>/);
  assert.equal(text, "Hi there");
});
