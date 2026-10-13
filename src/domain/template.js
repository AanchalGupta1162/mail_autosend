import { z } from "zod";

export const TEMPLATE_KEY = "followup_template";

export const DEFAULT_TEMPLATE = {
  subject: "Re: {{subject}}",
  body: "Hi {{firstName}},\n\nJust following up on my note about the {{role}} role at {{company}}. Happy to share anything that would help.\n\nBest,\nHarshavardhan Khamkar",
};

export const templateSchema = z.strictObject({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n\p{Cc}]*$/u, "subject must not contain line breaks or control characters"),
  body: z.string().min(1).max(5000),
});

const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;
const ALLOWED = new Set(["firstName", "person", "role", "company", "subject"]);

// Single pass over the template: substituted values are never scanned again, so a value
// containing "{{x}}" stays literal. Unknown names (including prototype keys) become "".
function fill(tpl, values) {
  return tpl.replace(PLACEHOLDER, (_m, name) => (ALLOWED.has(name) ? values[name] : ""));
}

const oneLine = (s) => String(s ?? "").replace(/[\r\n\p{Cc}]+/gu, " ").trim();

// contact: {person, role, company, subject, followupText}. Returns plain text {subject, text}.
// The sender escapes for HTML when composing; nothing here produces markup.
export function renderFollowup(contact, template = DEFAULT_TEMPLATE) {
  const person = oneLine(contact.person);
  const values = {
    person,
    firstName: person.split(/\s+/)[0] ?? "",
    role: String(contact.role ?? ""),
    company: String(contact.company ?? ""),
    subject: oneLine(contact.subject),
  };
  const subject = oneLine(fill(template.subject, { ...values, role: oneLine(values.role), company: oneLine(values.company) }));
  const custom = typeof contact.followupText === "string" && contact.followupText.trim() !== "";
  const text = custom ? contact.followupText : fill(template.body, values);
  return { subject, text };
}

export async function getTemplate(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [TEMPLATE_KEY]);
  const parsed = templateSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : DEFAULT_TEMPLATE;
}

export async function putTemplate(db, template) {
  await db.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [TEMPLATE_KEY, JSON.stringify(template)],
  );
  await db.query("INSERT INTO events(type, meta) VALUES ('template_updated', '{}'::jsonb)");
  return template;
}
