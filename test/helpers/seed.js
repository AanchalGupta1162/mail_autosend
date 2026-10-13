// Direct-SQL fixtures (the HTTP import path is covered in test/import).
export async function seedBatch(pool, emails, { name = "b", overrides = {} } = {}) {
  const b = await pool.query("INSERT INTO batches(name) VALUES ($1) RETURNING id", [name]);
  const batchId = b.rows[0].id;
  const contacts = [];
  for (const [i, email] of emails.entries()) {
    const o = overrides[email] ?? {};
    const { rows } = await pool.query(
      `INSERT INTO contacts(batch_id, company, role, person, email, subject, mail_text, followup_text, status, followup_requested, followup_delay_days, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, clock_timestamp()) RETURNING *`,
      [
        batchId,
        o.company ?? "Acme",
        o.role ?? "SWE Intern",
        o.person ?? "Jo Smith",
        email,
        o.subject ?? `Role ${i} at Acme`,
        o.mail_text ?? "Hi Jo,\n\nHello **there**.\n\nBest,\nH",
        o.followup_text ?? null,
        o.status ?? "uploaded",
        o.followup_requested ?? false,
        o.followup_delay_days ?? 7,
      ],
    );
    contacts.push(rows[0]);
  }
  return { batchId, contacts };
}

export async function addMessage(pool, contactId, { kind = "initial", state = "scheduled", scheduledFor = new Date(Date.now() - 60_000), messageId = null, sentAt = null, claimedAt = null, dryRun = false, attempts = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO messages(contact_id, kind, state, scheduled_for, message_id, sent_at, claimed_at, dry_run, attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [contactId, kind, state, scheduledFor, messageId, sentAt, claimedAt, dryRun, attempts],
  );
  return rows[0];
}
