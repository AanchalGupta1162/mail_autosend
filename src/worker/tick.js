import { setTimeout as delay } from "node:timers/promises";
import { inTx } from "../domain/contacts.js";
import { followupDueAt } from "../domain/schedule.js";
import { getTemplate } from "../domain/template.js";
import { classifySendError } from "./classify.js";
import { followupSendsAllowed } from "./sweep.js";
import { buildMail, loadSignature, newMessageId } from "./send.js";

export const STALE_SENDING_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MINUTES = [2, 10]; // after attempt 1, after attempt 2
const DAY_MS = 86_400_000;
const CLAIM_LOCK_KEY = 727_002; // serialises claim + cap accounting across concurrent ticks
const BLOCKED_STATUSES = new Set(["replied", "opted_out", "bounced", "failed"]);

const trim = (s) => String(s).slice(0, 500);

// --- stale recovery ---------------------------------------------------------------------------
// A row stuck in `sending` may or may not have been delivered. It is parked for a human and is
// never auto-resent.
async function recoverStale(pool, now) {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS);
  const { rows } = await pool.query(
    `UPDATE messages SET state = 'needs_review',
            error = 'Send was in flight for more than 10 minutes; delivery unknown. Check the Sent folder before retrying.'
      WHERE state = 'sending' AND claimed_at < $1
      RETURNING id, contact_id, kind`,
    [cutoff],
  );
  for (const r of rows) {
    await pool.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'needs_review', $2)", [
      r.contact_id,
      JSON.stringify({ messageId: r.id, kind: r.kind, reason: "stale_sending" }),
    ]);
  }
  return rows.length;
}

// --- claim ------------------------------------------------------------------------------------
// One transaction under an advisory lock: count (rolling 24h, same dry-run mode) -> claim ->
// store Message-IDs. The cap counts sent rows, rows in flight, and needs_review rows (which may
// have gone out). Dry-run and real sends are counted separately.
async function claim(pool, config, now, maxRows = 1, followupsAllowed = true) {
  return inTx(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_LOCK_KEY]);
    const since = new Date(now.getTime() - DAY_MS);
    const used = await db.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE dry_run = $1
          AND ((state = 'sent' AND sent_at > $2) OR state = 'sending' OR (state = 'needs_review' AND claimed_at > $2))`,
      [config.dryRun, since],
    );
    const limit = Math.min(maxRows, Math.max(0, config.dailySendCap - used.rows[0].n));
    if (limit <= 0) return [];
    const { rows } = await db.query(
      `UPDATE messages SET state = 'sending', claimed_at = $1, attempts = attempts + 1, dry_run = $2, error = NULL
        WHERE id IN (
          SELECT id FROM messages WHERE state = 'scheduled' AND scheduled_for <= $1 AND ($4::boolean OR kind <> 'followup')
           ORDER BY scheduled_for, created_at, id
           FOR UPDATE SKIP LOCKED LIMIT $3)
        RETURNING *`,
      [now, config.dryRun, limit, followupsAllowed],
    );
    rows.sort((a, b) => a.scheduled_for - b.scheduled_for || a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    for (const r of rows) {
      r.message_id = newMessageId(config);
      await db.query("UPDATE messages SET message_id = $2 WHERE id = $1", [r.id, r.message_id]);
    }
    return rows;
  });
}

// --- per-message ------------------------------------------------------------------------------
async function skipReason(db, contact, message) {
  if (BLOCKED_STATUSES.has(contact.status)) return `contact is ${contact.status}`;
  const sup = await db.query("SELECT 1 FROM suppressions WHERE email = lower($1)", [contact.email]);
  if (sup.rowCount) return "email is suppressed";
  const other = await db.query(
    `SELECT status FROM contacts WHERE lower(email) = lower($1) AND id <> $2 AND status IN ('replied','bounced','opted_out') LIMIT 1`,
    [contact.email, contact.id],
  );
  if (other.rowCount) return `same email is ${other.rows[0].status} in another batch`;
  if (message.kind === "initial" && contact.status !== "scheduled") return `contact is ${contact.status}, not scheduled`;
  if (message.kind === "followup") {
    if (contact.status !== "sent") return `contact is ${contact.status}, initial not sent`;
    if (!contact.followup_requested) return "follow-up is not requested";
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("send timed out"), { code: "ESENDTIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs one claimed message inside a single transaction that holds a FOR SHARE lock on the contact
// row for the whole SMTP call. markReplied/optOut/followup-toggle take FOR UPDATE on that row, so
// they wait until the send finishes instead of racing it: re-check + send are effectively atomic
// with respect to every user action on this contact.
async function processMessage({ pool, mailer, config, signatureHtml, sendTimeoutMs, logger }, claimed, clock) {
  const client = await pool.connect();
  let begun = false;
  let outcome = "lost";
  let sentOk = false;
  try {
    await client.query("BEGIN");
    begun = true;
    const c = await client.query("SELECT * FROM contacts WHERE id = $1 FOR SHARE", [claimed.contact_id]);
    // Still ours? (state sending + the Message-ID this worker generated)
    const m = await client.query(
      "SELECT * FROM messages WHERE id = $1 AND state = 'sending' AND message_id = $2 FOR UPDATE",
      [claimed.id, claimed.message_id],
    );
    if (!c.rowCount || !m.rowCount) {
      await client.query("COMMIT");
      return "lost";
    }
    const contact = c.rows[0];
    const message = m.rows[0];

    const why = await skipReason(client, contact, message);
    let initialMessageId = null;
    if (!why && message.kind === "followup") {
      const init = await client.query(
        "SELECT message_id FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state = 'sent' AND message_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
        [contact.id],
      );
      initialMessageId = init.rows[0]?.message_id ?? null;
    }
    const skip = why ?? (message.kind === "followup" && !initialMessageId ? "initial Message-ID unknown" : null);
    if (skip) {
      await client.query("UPDATE messages SET state = 'cancelled', error = $2 WHERE id = $1", [message.id, trim(`Not sent: ${skip}`)]);
      if (message.kind === "initial") {
        await client.query("UPDATE contacts SET status = 'uploaded' WHERE id = $1 AND status = 'scheduled'", [contact.id]);
      }
      await client.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'send_skipped', $2)", [
        contact.id,
        JSON.stringify({ messageId: message.id, kind: message.kind, reason: skip }),
      ]);
      await client.query("COMMIT");
      return "cancelled";
    }

    const template = message.kind === "followup" ? await getTemplate(client) : null;
    const mail = buildMail({ config, signatureHtml, contact, message, initialMessageId, template });

    let failure = null;
    try {
      await withTimeout(Promise.resolve(mailer.sendMail(mail)), sendTimeoutMs);
      sentOk = true;
    } catch (err) {
      failure = err;
    }

    if (!failure) {
      const sentAt = clock();
      await client.query("UPDATE messages SET state = 'sent', sent_at = $2, error = NULL WHERE id = $1", [message.id, sentAt]);
      if (message.kind === "initial") {
        await client.query("UPDATE contacts SET status = 'sent', error = NULL WHERE id = $1", [contact.id]);
        // Follow-up created in this same transaction, guarded by the live contact row: only when the
        // checkbox is still ticked and the contact is still in a sendable state.
        await client.query(
          `INSERT INTO messages(contact_id, kind, state, scheduled_for)
           SELECT c.id, 'followup', 'scheduled', $2 FROM contacts c
            WHERE c.id = $1 AND c.followup_requested AND c.status = 'sent'
              AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = lower(c.email))
           ON CONFLICT (contact_id, kind) WHERE state <> 'cancelled' DO NOTHING`,
          [contact.id, followupDueAt(sentAt, contact.followup_delay_days)],
        );
      }
      await client.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'sent', $2)", [
        contact.id,
        JSON.stringify({ messageId: message.id, kind: message.kind, dryRun: config.dryRun }),
      ]);
      await client.query("COMMIT");
      return "sent";
    }

    const verdict = classifySendError(failure);
    const note = trim(verdict.description);
    if (verdict.outcome === "ambiguous") {
      await client.query("UPDATE messages SET state = 'needs_review', error = $2 WHERE id = $1", [message.id, note]);
      await client.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'needs_review', $2)", [
        contact.id,
        JSON.stringify({ messageId: message.id, kind: message.kind, reason: "ambiguous_send_failure" }),
      ]);
      outcome = "needsReview";
    } else if (verdict.outcome === "retry" && message.attempts < MAX_ATTEMPTS) {
      const minutes = RETRY_BACKOFF_MINUTES[Math.min(message.attempts, RETRY_BACKOFF_MINUTES.length) - 1];
      await client.query(
        "UPDATE messages SET state = 'scheduled', scheduled_for = $2, error = $3, claimed_at = NULL WHERE id = $1",
        [message.id, new Date(clock().getTime() + minutes * 60_000), note],
      );
      outcome = "retried";
    } else {
      await client.query("UPDATE messages SET state = 'failed', error = $2 WHERE id = $1", [message.id, note]);
      if (message.kind === "initial") {
        await client.query("UPDATE contacts SET status = 'failed', error = $2 WHERE id = $1", [contact.id, note]);
      }
      await client.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'send_failed', $2)", [
        contact.id,
        JSON.stringify({ messageId: message.id, kind: message.kind, attempts: message.attempts }),
      ]);
      outcome = "failed";
    }
    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    if (sentOk) {
      // The mail went out but we could not record it. Best effort to record it; otherwise the row
      // stays `sending` and becomes needs_review. It is never re-sent.
      await pool
        .query("UPDATE messages SET state = 'sent', sent_at = $2 WHERE id = $1 AND message_id = $3", [claimed.id, clock(), claimed.message_id])
        .catch(() => {});
      logger.error(`recording a successful send failed: ${err?.name ?? "Error"} ${err?.code ?? ""}`.trim());
      return "sent";
    }
    logger.error(`processing a message failed: ${err?.name ?? "Error"} ${err?.code ?? ""}`.trim());
    return "error";
  } finally {
    client.release();
  }
}

// A claimed row that never entered processMessage (stop requested, error in the loop) is handed
// back untouched, so nothing is left in `sending` to be mistaken for a stale in-flight send.
async function release(pool, row) {
  await pool
    .query(
      `UPDATE messages SET state = 'scheduled', attempts = attempts - 1, message_id = NULL, claimed_at = NULL
        WHERE id = $1 AND state = 'sending' AND message_id = $2`,
      [row.id, row.message_id],
    )
    .catch(() => {});
}

export async function runTick({
  pool,
  mailer,
  config,
  now = () => new Date(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {}),
  random = Math.random,
  logger = console,
  sendTimeoutMs = 90_000,
  shouldStop = () => false, // set by the poller on shutdown
  signal, // AbortSignal that wakes the jitter sleep on shutdown
  onClaimed, // test seam: called after a claim commits, before the message is processed
}) {
  const clock = typeof now === "function" ? now : () => now;
  const summary = { staleRecovered: 0, claimed: 0, sent: 0, cancelled: 0, retried: 0, failed: 0, needsReview: 0 };
  summary.staleRecovered = await recoverStale(pool, clock());
  const ctx = { pool, mailer, config, signatureHtml: loadSignature(config), sendTimeoutMs, logger };
  let attemptedBefore = false;
  // One message per iteration: only the row in flight is ever in `sending`; cap and the
  // per-tick limit are re-evaluated before every claim.
  for (let i = 0; i < config.maxPerTick; i++) {
    if (shouldStop()) break;
    // Follow-ups wait while reply detection is stale (a reply could be sitting unseen).
    const followupsAllowed = await followupSendsAllowed(pool, config, clock());
    const [row] = await claim(pool, config, clock(), 1, followupsAllowed);
    if (!row) break;
    summary.claimed += 1;
    let entered = false;
    try {
      if (onClaimed) await onClaimed(row);
      if (attemptedBefore) {
        const min = config.sendGapSecondsMin;
        const max = Math.max(min, config.sendGapSecondsMax);
        await sleep(Math.round((min + random() * (max - min)) * 1000), signal);
      }
      if (shouldStop()) break;
      entered = true;
    } finally {
      if (!entered) await release(pool, row);
    }
    const result = await processMessage(ctx, row, clock);
    if (result in summary) summary[result] += 1;
    attemptedBefore = result === "sent" || result === "retried" || result === "failed" || result === "needsReview";
  }
  return summary;
}
