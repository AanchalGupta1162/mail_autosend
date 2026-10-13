import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv, CsvFileError, MAX_ROWS } from "../../src/import/parseCsv.js";

const H = '"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"';
const row = (o = {}) => {
  const v = { c: "Acme", r: "SWE", p: "Jo Bloggs", e: "jo@example.com", s: "SWE role at Acme", m: "Hi Jo,\n\nHello.\n\nBest,\nH", f: "", ...o };
  return [v.c, v.r, v.p, v.e, v.s, v.m, v.f].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",");
};
const buf = (...lines) => Buffer.from(lines.join("\n"), "utf8");

test("parses the sample fixture (5 valid rows, multi-line quoted cells)", () => {
  const { rows, errors } = parseCsv(readFileSync(new URL("../fixtures/sample.csv", import.meta.url)));
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].email, "aisha.rao@example.com");
  assert.match(rows[0].mailText, /^Hi Aisha,\n\n/);
  assert.equal(rows[0].row, 2);
});

test("strips a UTF-8 BOM and normalises CRLF in cells", () => {
  const b = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([H, row({ m: "a\r\nb" })].join("\r\n"), "utf8")]);
  const { rows, errors } = parseCsv(b);
  assert.deepEqual(errors, []);
  assert.equal(rows[0].mailText, "a\nb");
});

test("missing required header is a file-level error naming the column", () => {
  const b = buf('"Company","Role","Person","Email","Subject"', '"a","b","c","d@example.com","s"');
  assert.throws(() => parseCsv(b), (e) => e instanceof CsvFileError && /Mail Text/.test(e.message));
});

test("empty file and unterminated quote are file-level errors", () => {
  assert.throws(() => parseCsv(Buffer.alloc(0)), CsvFileError);
  assert.throws(() => parseCsv(buf(H, '"a","b')), CsvFileError);
});

test("follow-up text is optional (column may be absent)", () => {
  const { rows, errors } = parseCsv(buf('"Company","Role","Person","Email","Subject","Mail Text"', '"A","R","P","p@example.com","S","M"'));
  assert.deepEqual(errors, []);
  assert.equal(rows[0].followupText, null);
});

test("per-row validation: bad email, blank required, CR/LF in single-line fields", () => {
  const { rows, errors } = parseCsv(
    buf(
      H,
      row(),
      row({ e: "not-an-email" }),
      row({ e: "b@example.com", c: "" }),
      row({ e: "c@example.com", s: "Hi\r\nBcc: evil@example.com" }),
      row({ e: "d@example.com", p: "Jo\nBloggs" }),
      row({ e: "e@example.com", m: "   " }),
      row({ e: "x@example.com\r\nBcc: y@example.com" }),
      row({ e: "two@example.com, three@example.com" }),
    ),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(errors.map((e) => e.row), [3, 4, 5, 6, 7, 8, 9]);
  assert.match(errors[0].message, /email/i);
  assert.match(errors[1].message, /Company/);
  assert.match(errors[2].message, /Subject/);
});

test("duplicate emails within the file (case-insensitive) are reported, first wins", () => {
  const { rows, errors } = parseCsv(buf(H, row({ e: "Dup@Example.com" }), row({ e: "dup@example.com" })));
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 3);
  assert.match(errors[0].message, /duplicate/i);
});

test("suppressed emails are reported as errors", () => {
  const { rows, errors } = parseCsv(buf(H, row({ e: "Blocked@Example.com" }), row()), { suppressed: new Set(["blocked@example.com"]) });
  assert.equal(rows.length, 1);
  assert.match(errors[0].message, /suppress/i);
});

test("more than 500 rows is rejected as a whole; exactly 500 is fine", () => {
  const mk = (n) => buf(H, ...Array.from({ length: n }, (_, i) => row({ e: `u${i}@example.com` })));
  assert.equal(MAX_ROWS, 500);
  assert.equal(parseCsv(mk(500)).rows.length, 500);
  assert.throws(() => parseCsv(mk(501)), (e) => e instanceof CsvFileError && /500/.test(e.message));
});

test("blank lines are skipped; numeric-looking and formula-looking text stays text", () => {
  const { rows } = parseCsv(buf(H, "", row({ c: "007", s: "=1+1" })));
  assert.equal(rows[0].company, "007");
  assert.equal(rows[0].subject, "=1+1");
});
