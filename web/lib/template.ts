// Client-side preview of the follow-up template (same rules as src/domain/template.js:
// single pass, unknown placeholders become "", values are plain text).
import type { FollowupTemplate } from "./types";

export const PLACEHOLDERS = [
  { name: "firstName", help: "First word of the Person column" },
  { name: "person", help: "Person, as written in the CSV" },
  { name: "role", help: "Role" },
  { name: "company", help: "Company" },
  { name: "subject", help: "Subject of the first email" },
] as const;

const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;
const ALLOWED = new Set<string>(PLACEHOLDERS.map((p) => p.name));

export function fillTemplate(tpl: string, v: { person: string; role: string; company: string; subject: string }): string {
  const values: Record<string, string> = { ...v, firstName: v.person.trim().split(/\s+/)[0] ?? "" };
  return tpl.replace(PLACEHOLDER, (_m, name: string) => (ALLOWED.has(name) ? (values[name] ?? "") : ""));
}

export function validateTemplate(t: FollowupTemplate): { subject?: string; body?: string } {
  const out: { subject?: string; body?: string } = {};
  const subject = t.subject.trim();
  if (!subject) out.subject = "Enter a subject";
  else if (/[\r\n\u0000-\u001f\u007f]/.test(subject)) out.subject = "Subject must be one line without line breaks";
  else if (subject.length > 200) out.subject = "Subject must be 200 characters or fewer";
  if (!t.body.trim()) out.body = "Enter the follow-up text";
  else if (t.body.length > 5000) out.body = "Text must be 5000 characters or fewer";
  return out;
}
