// CSV import: same header contract as the formatting-email-csv skill.
// Small RFC 4180 parser (no type coercion: every cell stays text).

export const MAX_ROWS = 500;
export const MAX_FIELD = 300;
export const MAX_TEXT = 20000;

const COLUMNS = [
  ["Company", "company", true, true],
  ["Role", "role", true, true],
  ["Person", "person", true, true],
  ["Email", "email", true, true],
  ["Subject", "subject", true, true],
  ["Mail Text", "mailText", true, false],
  ["Follow-up Text", "followupText", false, false],
]; // [header, key, required, singleLine]

// File-level problem: nothing is imported (maps to HTTP 400).
export class CsvFileError extends Error {}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function tokenize(text) {
  const records = [];
  let rec = [];
  let cell = "";
  let inQuotes = false;
  let quotedCell = false;
  const endCell = () => {
    rec.push(cell);
    cell = "";
    quotedCell = false;
  };
  const endRecord = () => {
    endCell();
    if (!(rec.length === 1 && rec[0].trim() === "")) records.push(rec);
    rec = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "" && !quotedCell) {
      inQuotes = true;
      quotedCell = true;
    } else if (ch === ",") endCell();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
    } else if (ch === "\n") endRecord();
    else cell += ch;
  }
  if (inQuotes) throw new CsvFileError("Malformed CSV: unterminated quoted field");
  if (cell !== "" || rec.length) endRecord();
  return records;
}

// -> {rows:[{row, company, role, person, email, subject, mailText, followupText}], errors:[{row, message}]}
// `row` is the 1-based line-record number in the file (header = 1). Throws CsvFileError for file-level problems.
export function parseCsv(buffer, { suppressed = new Set() } = {}) {
  let text = Buffer.from(buffer).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) throw new CsvFileError("File is not a text CSV");
  const records = tokenize(text);
  if (records.length === 0) throw new CsvFileError("The CSV file is empty");

  const header = records[0].map((h) => h.trim());
  const index = {};
  for (const [name, key, required] of COLUMNS) {
    const i = header.indexOf(name);
    if (i === -1) {
      if (required) throw new CsvFileError(`Missing required column: "${name}"`);
    } else index[key] = i;
  }
  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_ROWS) throw new CsvFileError(`Too many rows: the limit is ${MAX_ROWS} per file`);

  const rows = [];
  const errors = [];
  const seen = new Set();
  dataRecords.forEach((rec, n) => {
    const row = n + 2;
    const v = {};
    for (const [, key] of COLUMNS) {
      const raw = index[key] === undefined ? "" : (rec[index[key]] ?? "");
      v[key] = raw.replace(/\r\n?/g, "\n").trim();
    }
    const fail = (message) => errors.push({ row, message });
    for (const [name, key, required, singleLine] of COLUMNS) {
      if (required && v[key] === "") return fail(`${name} is required`);
      if (singleLine && /[\r\n\u0000-\u001f]/.test(v[key])) return fail(`${name} must be a single line without control characters`);
      if (v[key].length > (singleLine ? MAX_FIELD : MAX_TEXT)) return fail(`${name} is too long`);
    }
    if (v.email.length > 254 || !EMAIL_RE.test(v.email)) return fail("Email is not a valid address");
    const lower = v.email.toLowerCase();
    if (seen.has(lower)) return fail("Duplicate email in this file");
    if (suppressed.has(lower)) return fail("Email is on the suppression list");
    seen.add(lower);
    rows.push({ row, ...v, followupText: v.followupText === "" ? null : v.followupText });
  });
  return { rows, errors };
}
