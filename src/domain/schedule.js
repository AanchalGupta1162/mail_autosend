import { HttpError } from "../server/errors.js";
import { inTx, serializeContact } from "./contacts.js";

export const MAX_DAYS_AHEAD = 90;
const DAY_MS = 86_400_000;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function serializeMessage(r) {
  return {
    id: r.id,
    contactId: r.contact_id,
    kind: r.kind,
    state: r.state,
    scheduledFor: r.scheduled_for,
    sentAt: r.sent_at,
    attempts: r.attempts,
    error: r.error,
    dryRun: r.dry_run,
    createdAt: r.created_at,
  };
}

const bad = (msg) => new HttpError(400, msg);

// sendAt must be an ISO-8601 instant WITH an offset (or Z), strictly in the future, <= 90 days out.
export function validateSendAt(value, now = new Date()) {
  if (typeof value !== "string") throw bad("sendAt must be an ISO date-time string");
  const m = ISO_INSTANT.exec(value);
  if (!m) throw bad("sendAt must be an ISO date-time with a timezone, e.g. 2026-10-20T09:00:00Z");
  const [, y, mo, d, h, mi, s = "0"] = m;
  const probe = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (probe.getUTCFullYear() !== +y || probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) {
    throw bad("sendAt is not a valid date");
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw bad("sendAt is not a valid date");
  if (at.getTime() <= now.getTime()) throw bad("sendAt must be in the future");
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) throw bad(`sendAt must be within ${MAX_DAYS_AHEAD} days`);
  return at;
}

// count send times starting at `start`, `staggerMinutes` apart, in order.
export function planStagger(start, count, staggerMinutes = 0) {
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * staggerMinutes * 60_000));
}

export class RefusedError extends HttpError {
  constructor(refused) {
    super(409, "Some contacts cannot be scheduled", { refused });
  }
}

const BLOCKING_STATUS = new Set(["replied", "bounced", "opted_out", "failed"]);

// Why a locked contact row (with .suppressed / .other_status) may not be (re)scheduled, or null.
export function refusalReason(row, { allowScheduled = false, allowSent = false } = {}) {
  if (BLOCKING_STATUS.has(row.status)) return row.status;
  if (row.suppressed) return "suppressed";
  if (row.other_status) return `other_batch_${row.other_status}`;
  if (row.status === "sent" && !allowSent) return "already_sent";
  if (row.status === "scheduled" && !allowScheduled) return "already_scheduled";
  return null;
}

// Locks the contacts (sorted, to avoid deadlocks) and returns them with the suppression and
// cross-batch flags computed under the lock. Cross-batch: the same email (case-insensitive)
// exists as replied/bounced/opted_out in ANY other contact row.
export async function lockContactsForScheduling(db, ids) {
  await db.query("SELECT id FROM contacts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
  const { rows } = await db.query(
    `SELECT c.*,
            EXISTS (SELECT 1 FROM suppressions s WHERE s.email = lower(c.email)) AS suppressed,
            (SELECT c2.status FROM contacts c2
              WHERE lower(c2.email) = lower(c.email) AND c2.id <> c.id
                AND c2.status IN ('replied','bounced','opted_out')
              ORDER BY c2.status LIMIT 1) AS other_status
       FROM contacts c WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

const refusal = (row, reason) => ({ contactId: row.id, email: row.email, reason });

function mapUnique(err) {
  if (err?.code === "23505") return new HttpError(409, "A message is already scheduled for this contact");
  return err;
}

// All-or-nothing: if any contact is refused, nothing is scheduled and the 409 body names every
// refused contact with a reason.
export async function scheduleBulk(pool, { batchId, contactIds, sendAt, staggerMinutes = 0 }) {
  const b = await pool.query("SELECT id FROM batches WHERE id = $1", [batchId]);
  if (!b.rowCount) throw new HttpError(404, "Batch not found");
  const times = planStagger(sendAt, contactIds.length, staggerMinutes);
  try {
    return await inTx(pool, async (db) => {
      const rows = await lockContactsForScheduling(db, contactIds);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const refused = [];
      for (const id of contactIds) {
        const row = byId.get(id);
        if (!row || row.batch_id !== batchId) {
          refused.push({ contactId: id, email: row && row.batch_id !== batchId ? row.email : null, reason: "not_in_batch" });
          continue;
        }
        const reason = refusalReason(row);
        if (reason) refused.push(refusal(row, reason));
      }
      if (refused.length) throw new RefusedError(refused);
      const out = [];
      for (const [i, id] of contactIds.entries()) {
        const m = await db.query(
          `INSERT INTO messages(contact_id, kind, state, scheduled_for) VALUES ($1, 'initial', 'scheduled', $2) RETURNING *`,
          [id, times[i]],
        );
        await db.query("UPDATE contacts SET status = 'scheduled' WHERE id = $1", [id]);
        await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'scheduled', $2)", [
          id,
          JSON.stringify({ messageId: m.rows[0].id, scheduledFor: times[i].toISOString() }),
        ]);
        out.push(serializeMessage(m.rows[0]));
      }
      return out;
    });
  } catch (err) {
    throw mapUnique(err);
  }
}

// Schedule, or reschedule an unsent initial, for one contact.
export async function scheduleContact(pool, contactId, sendAt) {
  try {
    return await inTx(pool, async (db) => {
      const rows = await lockContactsForScheduling(db, [contactId]);
      if (!rows.length) throw new HttpError(404, "Contact not found");
      const row = rows[0];
      const reason = refusalReason(row, { allowScheduled: true });
      if (reason) throw new RefusedError([refusal(row, reason)]);
      const live = await db.query(
        "SELECT * FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state <> 'cancelled' FOR UPDATE",
        [contactId],
      );
      let msg;
      if (!live.rowCount) {
        msg = (
          await db.query(
            `INSERT INTO messages(contact_id, kind, state, scheduled_for) VALUES ($1, 'initial', 'scheduled', $2) RETURNING *`,
            [contactId, sendAt],
          )
        ).rows[0];
      } else if (live.rows[0].state === "scheduled") {
        msg = (await db.query("UPDATE messages SET scheduled_for = $2 WHERE id = $1 RETURNING *", [live.rows[0].id, sendAt])).rows[0];
      } else {
        throw new HttpError(409, `Message is already ${live.rows[0].state} and cannot be rescheduled`);
      }
      await db.query("UPDATE contacts SET status = 'scheduled' WHERE id = $1", [contactId]);
      await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, $2, $3)", [
        contactId,
        live.rowCount ? "rescheduled" : "scheduled",
        JSON.stringify({ messageId: msg.id, scheduledFor: sendAt.toISOString() }),
      ]);
      return serializeMessage(msg);
    });
  } catch (err) {
    throw mapUnique(err);
  }
}

// Cancels a still-`scheduled` message. A message the worker already claimed cannot be cancelled here.
export async function cancelMessage(pool, messageId) {
  return inTx(pool, async (db) => {
    const found = await db.query("SELECT contact_id FROM messages WHERE id = $1", [messageId]);
    if (!found.rowCount) throw new HttpError(404, "Message not found");
    const contactId = found.rows[0].contact_id;
    await db.query("SELECT id FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
    const upd = await db.query(
      "UPDATE messages SET state = 'cancelled' WHERE id = $1 AND state = 'scheduled' RETURNING *",
      [messageId],
    );
    if (!upd.rowCount) throw new HttpError(409, "Only a scheduled message can be cancelled");
    const msg = upd.rows[0];
    if (msg.kind === "initial") {
      await db.query("UPDATE contacts SET status = 'uploaded' WHERE id = $1 AND status = 'scheduled'", [contactId]);
    } else {
      await db.query("UPDATE contacts SET followup_requested = false WHERE id = $1", [contactId]);
    }
    await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'message_cancelled', $2)", [
      contactId,
      JSON.stringify({ messageId, kind: msg.kind, source: "manual" }),
    ]);
    const c = await db.query("SELECT * FROM contacts WHERE id = $1", [contactId]);
    return { message: serializeMessage(msg), contact: serializeContact(c.rows[0]) };
  });
}

export const followupDueAt = (sentAt, delayDays) => new Date(new Date(sentAt).getTime() + delayDays * DAY_MS);

// Follow-up checkbox. See the API section of the plan.
export async function syncFollowup(pool, contactId, { enabled, delayDays }) {
  try {
    return await inTx(pool, async (db) => {
      const rows = await lockContactsForScheduling(db, [contactId]);
      if (!rows.length) throw new HttpError(404, "Contact not found");
      const row = rows[0];
      if (enabled) {
        const reason = refusalReason(row, { allowScheduled: true, allowSent: true });
        if (reason) throw new RefusedError([refusal(row, reason)]);
      }
      const delay = delayDays ?? row.followup_delay_days;
      const upd = await db.query(
        "UPDATE contacts SET followup_requested = $2, followup_delay_days = $3 WHERE id = $1 RETURNING *",
        [contactId, enabled, delay],
      );
      let followup = null;
      const live = await db.query(
        "SELECT * FROM messages WHERE contact_id = $1 AND kind = 'followup' AND state <> 'cancelled' FOR UPDATE",
        [contactId],
      );
      if (!enabled) {
        const cancelled = await db.query(
          "UPDATE messages SET state = 'cancelled' WHERE contact_id = $1 AND kind = 'followup' AND state = 'scheduled' RETURNING id",
          [contactId],
        );
        await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'followup_disabled', $2)", [
          contactId,
          JSON.stringify({ cancelledMessages: cancelled.rowCount }),
        ]);
      } else {
        if (row.status === "sent") {
          const init = await db.query(
            "SELECT sent_at FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state = 'sent' ORDER BY sent_at DESC LIMIT 1",
            [contactId],
          );
          if (init.rowCount) {
            const due = followupDueAt(init.rows[0].sent_at, delay);
            if (!live.rowCount) {
              followup = (
                await db.query(
                  "INSERT INTO messages(contact_id, kind, state, scheduled_for) VALUES ($1, 'followup', 'scheduled', $2) RETURNING *",
                  [contactId, due],
                )
              ).rows[0];
            } else if (live.rows[0].state === "scheduled") {
              followup = (await db.query("UPDATE messages SET scheduled_for = $2 WHERE id = $1 RETURNING *", [live.rows[0].id, due])).rows[0];
            } else {
              followup = live.rows[0];
            }
          }
        } else if (live.rowCount) {
          followup = live.rows[0];
        }
        await db.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'followup_enabled', $2)", [
          contactId,
          JSON.stringify({ delayDays: delay }),
        ]);
      }
      return { contact: serializeContact(upd.rows[0]), followup: followup ? serializeMessage(followup) : null };
    });
  } catch (err) {
    throw mapUnique(err);
  }
}
