import { HttpError } from "../server/errors.js";

export const CONTACT_STATUSES = ["uploaded", "scheduled", "sent", "replied", "bounced", "opted_out", "failed"];

export function serializeContact(r) {
  return {
    id: r.id,
    batchId: r.batch_id,
    company: r.company,
    role: r.role,
    person: r.person,
    email: r.email,
    subject: r.subject,
    mailText: r.mail_text,
    followupText: r.followup_text,
    status: r.status,
    followupRequested: r.followup_requested,
    followupDelayDays: r.followup_delay_days,
    repliedAt: r.replied_at,
    error: r.error,
    createdAt: r.created_at,
  };
}

export function serializeBatch(r) {
  return { id: r.id, name: r.name, originalFilename: r.original_filename, createdAt: r.created_at };
}

async function inTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Cancels pending (scheduled) messages only; an in-flight 'sending' row is left to the worker.
const CANCEL_PENDING = `UPDATE messages SET state = 'cancelled' WHERE contact_id = ANY($1::uuid[]) AND state = 'scheduled' RETURNING contact_id`;

export async function markReplied(pool, id, { source = "manual" } = {}) {
  return inTx(pool, async (db) => {
    const cur = await db.query("SELECT status FROM contacts WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rowCount) throw new HttpError(404, "Contact not found");
    if (cur.rows[0].status === "opted_out") throw new HttpError(409, "Contact has opted out");
    if (cur.rows[0].status === "replied") {
      // Idempotent: nothing to rewrite, no second event.
      const same = await db.query("SELECT * FROM contacts WHERE id = $1", [id]);
      return serializeContact(same.rows[0]);
    }
    const { rows } = await db.query(
      `UPDATE contacts SET status = 'replied', replied_at = COALESCE(replied_at, now()), followup_requested = false WHERE id = $1 RETURNING *`,
      [id],
    );
    const cancelled = await db.query(CANCEL_PENDING, [[id]]);
    await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'replied', $2)", [
      id,
      JSON.stringify({ source, cancelledMessages: cancelled.rowCount }),
    ]);
    return serializeContact(rows[0]);
  });
}

// Suppresses the address, then stops every not-yet-final contact that shares it.
export async function optOut(pool, id) {
  return inTx(pool, async (db) => {
    const cur = await db.query("SELECT lower(email) AS email FROM contacts WHERE id = $1 FOR UPDATE", [id]);
    if (!cur.rowCount) throw new HttpError(404, "Contact not found");
    const email = cur.rows[0].email;
    await db.query(
      "INSERT INTO suppressions(email, reason) VALUES ($1, 'opt_out') ON CONFLICT (email) DO NOTHING",
      [email],
    );
    const affected = await db.query(
      `UPDATE contacts SET status = 'opted_out'
        WHERE (lower(email) = $1 AND status NOT IN ('opted_out', 'replied', 'bounced'))
           OR (id = $2 AND status <> 'opted_out')
        RETURNING id`,
      [email, id],
    );
    const ids = affected.rows.map((r) => r.id);
    const cancelled = await db.query(CANCEL_PENDING, [ids]);
    for (const cid of ids) {
      await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'opted_out', $2)", [
        cid,
        JSON.stringify({ source: "manual", cancelledMessages: cancelled.rows.filter((r) => r.contact_id === cid).length }),
      ]);
    }
    const { rows } = await db.query("SELECT * FROM contacts WHERE id = $1", [id]);
    return serializeContact(rows[0]);
  });
}

export { inTx };
