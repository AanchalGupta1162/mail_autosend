import { setTimeout as delay } from "node:timers/promises";
import { inTx } from "../domain/contacts.js";
import { followupDueAt } from "../domain/schedule.js";
import { getTemplate } from "../domain/template.js";
import { classifySendError } from "./classify.js";
import { followupSendsAllowed } from "./sweep.js";
import { buildMail, createResumeCache, loadAttachments, loadSignature, newMessageId } from "./send.js";
import { createResumeStorage } from "../storage/resumes.js";

export const STALE_SENDING_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
export const HOLD_MINUTES = 15; // credential/config errors: try again this much later, attempts untouched
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
    // Keep a Message-ID stored by an earlier attempt (retry / requeue): one logical email, one id.
    for (const r of rows) {
      r.message_id ??= newMessageId(config);
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
async function processMessage({ pool, mailer, config, sendTimeoutMs, resumeFetchTimeoutMs, logger, storage, cache }, claimed, clock) {
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
    let dryInitial = false;
    if (!why && message.kind === "followup") {
      const init = await client.query(
        "SELECT message_id, dry_run FROM messages WHERE contact_id = $1 AND kind = 'initial' AND state = 'sent' AND message_id IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
        [contact.id],
      );
      initialMessageId = init.rows[0]?.message_id ?? null;
      // A dry-run "send" delivered nothing: a real follow-up would thread onto a Message-ID no one has.
      if (initialMessageId && init.rows[0].dry_run && !config.dryRun) dryInitial = true;
    }
    const skip =
      why ??
      (dryInitial ? "the first email was a dry run (nothing was delivered), so there is nothing to follow up on" : null) ??
      (message.kind === "followup" && !initialMessageId ? "initial Message-ID unknown" : null);
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
    let failure = null;
    let signatureHtml = "";
    try {
      // Read at send time: a signature that vanished after startup must not produce an unsigned mail.
      signatureHtml = loadSignature(config);
    } catch (err) {
      failure = err; // classified as a pre-send (retryable) failure; nothing is handed to SMTP
    }
    let attachments = [];
    if (!failure) {
      try {
        // Pre-send, like the signature: the snapshotted resume (or the legacy file) is read here so any
        // failure is a hold and nothing is handed to SMTP without it.
        attachments = await loadAttachments({ config, message, db: client, storage: storage(), cache, timeoutMs: resumeFetchTimeoutMs });
      } catch (err) {
        failure = err;
      }
    }
    const mail = failure ? null : buildMail({ config, signatureHtml, contact, message, initialMessageId, template, attachments });

    try {
      if (failure) throw failure;
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
          `INSERT INTO messages(contact_id, kind, state, scheduled_for, resume_id, resume_generation)
           SELECT c.id, 'followup', 'scheduled', $2, $3, $4 FROM contacts c
            WHERE c.id = $1 AND c.followup_requested AND c.status = 'sent'
              AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = lower(c.email))
           ON CONFLICT (contact_id, kind) WHERE state <> 'cancelled' DO NOTHING`,
          [contact.id, followupDueAt(sentAt, contact.followup_delay_days), message.resume_id, message.resume_generation],
        );
      }
      await client.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'sent', $2)", [
        contact.id,
        JSON.stringify({ messageId: message.id, kind: message.kind, dryRun: config.dryRun }),
      ]);
      // A real send proves credentials and files work again. A resume-scoped hold concerns one resume
      // (other mail is unaffected), so only a successful send of that very message clears it.
      if (!config.dryRun) {
        await client.query(
          "DELETE FROM settings WHERE key = 'send_hold' AND (value->>'scope' IS DISTINCT FROM 'resume' OR value->>'messageId' = $1)",
          [message.id],
        );
      }
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
    } else if (verdict.outcome === "hold") {
      // Nothing was sent and the cause is not this message: put it back without using an attempt,
      // never mark the contact failed, and leave a visible marker for the dashboard.
      await client.query(
        "UPDATE messages SET state = 'scheduled', scheduled_for = $2, attempts = GREATEST(attempts - 1, 0), claimed_at = NULL, error = $3 WHERE id = $1",
        [message.id, new Date(clock().getTime() + HOLD_MINUTES * 60_000), note],
      );
      // A library resume that cannot be fetched concerns that resume only: other mail keeps flowing.
      // Everything else (credentials, signature, legacy file) is systemic and pauses the queue.
      const resumeScope = failure?.code === "ERESUME";
      const holdInfo = {
        at: clock().toISOString(),
        code: String(failure?.code ?? "ERROR"),
        message: note,
        ...(resumeScope ? { scope: "resume", messageId: message.id } : {}),
      };
      // A resume-scoped marker never replaces a systemic one that is still inside its window: that would
      // hide a rejected app password from the R2 pause and the banner.
      const activeSince = new Date(clock().getTime() - HOLD_MINUTES * 60_000).toISOString();
      await client.query(
        `INSERT INTO settings(key, value) VALUES ('send_hold', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
          WHERE NOT $2::boolean
             OR settings.value->>'scope' = 'resume'
             OR settings.value->>'at' IS NULL
             OR settings.value->>'at' < $3`,
        [JSON.stringify(holdInfo), resumeScope, activeSince],
      );
      await client.query("INSERT INTO events(contact_id, type, meta) VALUES ($1, 'send_held', $2)", [
        contact.id,
        JSON.stringify({ messageId: message.id, kind: message.kind, code: holdInfo.code }),
      ]);
      outcome = resumeScope ? "heldResume" : "held";
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
      // stays `sending` and becomes needs_review. It is never re-sent. Only a row still in this
      // attempt's states may be flipped: with Message-ID reuse, a row since resolved/requeued/
      // cancelled by the operator must not be forced to sent by a stale worker.
      await pool
        .query("UPDATE messages SET state = 'sent', sent_at = $2 WHERE id = $1 AND message_id = $3 AND state IN ('sending', 'needs_review')", [claimed.id, clock(), claimed.message_id])
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
  resumeFetchTimeoutMs = 30_000,
  shouldStop = () => false, // set by the poller on shutdown
  signal, // AbortSignal that wakes the jitter sleep on shutdown
  onClaimed, // test seam: called after a claim commits, before the message is processed
  resumeStorage, // resume object storage (default: built from config on first use)
}) {
  const clock = typeof now === "function" ? now : () => now;
  const summary = { staleRecovered: 0, claimed: 0, sent: 0, cancelled: 0, held: 0, retried: 0, failed: 0, needsReview: 0 };
  summary.staleRecovered = await recoverStale(pool, clock());
  // R2: a systemic hold younger than HOLD_MINUTES pauses real sending entirely, so a rejected app password
  // is retried once per window instead of on every poll. Dry-run is never paused; a resume-scoped hold never pauses.
  if (!config.dryRun) {
    const hold = (await pool.query("SELECT value FROM settings WHERE key = 'send_hold'")).rows[0]?.value;
    const heldAt = hold && hold.scope !== "resume" ? Date.parse(hold.at) : NaN;
    if (!Number.isNaN(heldAt) && clock().getTime() - heldAt < HOLD_MINUTES * 60_000) return { ...summary, paused: true };
  }
  let storage;
  const ctx = { pool, mailer, config, sendTimeoutMs, resumeFetchTimeoutMs, logger, cache: createResumeCache(), storage: () => (storage ??= resumeStorage ?? createResumeStorage(config)) };
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
    else if (result === "heldResume") summary.held += 1;
    if (result === "held") break; // systemic (credentials/config): do not hammer SMTP with every due message
    attemptedBefore = result === "sent" || result === "retried" || result === "failed" || result === "needsReview";
  }
  return summary;
}
