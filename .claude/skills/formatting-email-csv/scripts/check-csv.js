import fs from "node:fs";

const HEADERS = ["Company", "Role", "Person", "Email", "Subject", "Mail Text", "Follow-up Text"];
const REQUIRED = HEADERS.slice(0, 6);

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (inQuotes) throw new Error("Unterminated quoted field");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const file = process.argv[2];
if (!file) { console.error("Usage: node check-csv.js <file.csv>"); process.exit(2); }

const errors = [];
const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
const header = rows[0] ?? [];
if (header.join("|") !== HEADERS.join("|")) {
  errors.push(`Header must be exactly: ${HEADERS.join(",")} (got: ${header.join(",")})`);
}
rows.slice(1).forEach((r, i) => {
  const n = i + 2;
  if (r.length !== HEADERS.length) errors.push(`Row ${n}: expected ${HEADERS.length} fields, got ${r.length}`);
  const get = (name) => (r[HEADERS.indexOf(name)] ?? "").trim();
  for (const name of REQUIRED) if (!get(name)) errors.push(`Row ${n}: "${name}" is empty`);
  if (get("Email") && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(get("Email"))) errors.push(`Row ${n}: invalid Email "${get("Email")}"`);
  if (/\*\*|\n/.test(get("Subject"))) errors.push(`Row ${n}: Subject must be plain single-line text`);
  for (const name of ["Mail Text", "Follow-up Text"]) {
    const v = get(name);
    if ((v.match(/\*\*/g) ?? []).length % 2) errors.push(`Row ${n}: unbalanced ** in "${name}"`);
    if (v && !/^Hi\b/.test(v)) errors.push(`Row ${n}: "${name}" should start with "Hi <FirstName>,"`);
    if (v && !/Best,\s*\n\s*Harshavardhan Khamkar\s*$/.test(v)) errors.push(`Row ${n}: "${name}" should end with "Best,\\nHarshavardhan Khamkar"`);
  }
});

if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`OK: ${rows.length - 1} row(s) valid`);
