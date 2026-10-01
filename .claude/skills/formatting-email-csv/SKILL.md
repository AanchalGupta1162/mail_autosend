---
name: formatting-email-csv
description: Use when drafted recruiter/outreach emails (initial or follow-up) need to be put into the CSV that feeds the mail-autosend sheet, or when a drafted-email CSV needs checking before import.
---

# Formatting Drafted Emails as CSV

## Overview
mail-autosend reads one row per recipient (see `src/excel.js`). This skill turns drafted emails into a CSV whose columns, quoting and text markup match that schema exactly. The app reads `.csv` directly: point `EXCEL_PATH` in `.env` at the file. It writes `Status`, `Message ID` etc. back into the same CSV, so edit it in a plain text editor or re-import carefully while a run is not in progress.

## Columns (exact header text, this order)
`Company,Role,Person,Email,Subject,Mail Text,Follow-up Text`

| Column | Required | Rule |
|---|---|---|
| Company | yes | Plain text |
| Role | yes | Plain text, e.g. `Software Engineer Intern` |
| Person | yes | Recipient's full name |
| Email | yes | One valid address; rows with blank Email are skipped by the app |
| Subject | yes | Plain text, no `**`, no newlines. Pattern: `<Role> role at <Company>` |
| Mail Text | yes | Body of the initial email (format below) |
| Follow-up Text | no | Body of follow-ups; leave empty to never follow up |

Do NOT include `Status, Message ID, Last Sent At, Follow-up Count, Error` — the app adds and owns them.

## Text formatting (Mail Text and Follow-up Text)
- Plain text only. The app converts it to HTML: `\n` becomes a line break, HTML is escaped.
- Bold is `**like this**` (non-nested, same line). Bold the role title, and little else. No other markdown (no `*italics*`, `#`, lists with `-`, links syntax).
- Structure: `Hi <FirstName>,` → blank line → paragraphs separated by one blank line (`\n\n`) → closing question/ask → blank line → `Best,` newline `Harshavardhan Khamkar`.
- Follow-up: short (2–3 lines), references the role in bold, says it is a follow-up, ends with `Best,\nHarshavardhan Khamkar`. It is sent as `Re: <Subject>` in the same thread, so write no subject for it.
- Do not paste the signature block, phone/links, or "attached resume" lines for follow-ups; the app appends the signature (`signature.html`) and attaches the resume on initial emails only. Mention "I've attached my resume" only in Mail Text.
- Do not use tabs or `\r`; use real line breaks inside the quoted cell.

## CSV encoding
- UTF-8, comma-delimited, header row first.
- Wrap EVERY field in double quotes; escape an inner `"` as `""`. Multi-line text stays inside its quoted cell.
- No blank lines between rows, no trailing commas.

## Example
```csv
"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"
"Acme Robotics","Software Engineer Intern","Priya Nair","priya@acme.com","Software Engineer Intern role at Acme Robotics","Hi Priya,

I came across the **Software Engineer Intern** opening at Acme Robotics and wanted to reach out directly. I've built ...

Would you be open to a quick chat? I've attached my resume.

Best,
Harshavardhan Khamkar","Hi Priya,

Following up on my note about the **Software Engineer Intern** role — would love your thoughts.

Best,
Harshavardhan Khamkar"
```

## Verify before handing over
Run `node .claude/skills/formatting-email-csv/scripts/check-csv.js <file.csv>`. It checks headers, required fields, email shape, and unbalanced `**`. Fix everything it reports.

## Common mistakes
- Unquoted multi-line cells or commas in text → rows split. Quote every field.
- Extra columns or renamed headers (`Mail Body`, `Name`) → app throws "missing required column".
- `**` left unbalanced → literal asterisks in the sent email.
- Signature or contact details duplicated in the body.
- Editing the CSV in Excel between runs and saving with a different encoding or delimiter.
