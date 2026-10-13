import { createReplyChecker } from "../imap.js";
import { markReplied } from "../domain/contacts.js";

export const SWEEP_WINDOW_DAYS = 30; // only initials sent within this many days are checked
export const SWEEP_STALE_MS = 60 * 60_000; // fallback when config.sweepMaxAgeMinutes (SWEEP_MAX_AGE_MINUTES) is unset
const DAY_MS = 86_400_000;
const STATE_KEY = "sweep_state";
const FATAL_CODES = new Set([
  "EAUTH", "AUTHENTICATIONFAILED", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "EAI_AGAIN", "EPIPE", "NOCONNECTION", "CLOSEDAFTERCONNECTTLS", "ECONNECTION",
]);

// A sweep counts as successful (advances lastSuccessAt, releases the follow-up hold) when there was
// no fatal error and no more than max(3, 5%) of the candidates failed; one poisoned row must not
// hold every follow-up for 30 days. rowErrors stays visible on the dashboard.
export function sweepTolerance(candidates) {
  return Math.max(3, Math.floor(candidates * 0.05));
}

// Success = no fatal error AND (nothing to check OR at least one check really completed) AND
// rowErrors within tolerance, where tolerance can never cover every candidate. A systematic
// non-fatal failure (every search errors) therefore never reads as a healthy sweep.
export function sweepOk({ candidates, checked, rowErrors }) {
  if (candidates === 0) return rowErrors <= sweepTolerance(0);
  return checked > 0 && rowErrors <= Math.min(sweepTolerance(candidates), candidates - 1);
}

// Connection/auth class errors poison the whole run; anything else is a per-row problem.
export function isFatalSweepError(err) {
  return Boolean(err?.fatal || err?.authenticationFailed || FATAL_CODES.has(String(err?.code ?? "").toUpperCase()));
}

async function readState(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [STATE_KEY]);
  return rows[0]?.value ?? null;
}

async function writeState(db, value) {
  await db.query(
    "INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [STATE_KEY, JSON.stringify(value)],
  );
}

// Follow-ups go out only while reply detection is fresh: in real mode with the sweep enabled the
// last fully successful sweep must be newer than SWEEP_STALE_MS. Initial sends are never held.
export async function followupSendsAllowed(pool, config, now = new Date()) {
  if (config.dryRun || config.replySweepEnabled !== true) return true;
  const last = (await readState(pool))?.lastSuccessAt;
  const maxAgeMs = config.sweepMaxAgeMinutes ? config.sweepMaxAgeMinutes * 60_000 : SWEEP_STALE_MS;
  return Boolean(last) && now.getTime() - new Date(last).getTime() <= maxAgeMs;
}

// Oldest-attempted first (never-attempted first), so no contact is starved by a failing one.
const CANDIDATES = `
  SELECT c.id, c.email, c.subject, m.message_id, m.sent_at
    FROM contacts c
    JOIN messages m ON m.contact_id = c.id AND m.kind = 'initial' AND m.state = 'sent'
                   AND ($1::boolean IS NULL OR m.dry_run = $1)
   WHERE c.status = 'sent' AND c.replied_at IS NULL AND m.message_id IS NOT NULL AND m.sent_at > $2
   ORDER BY c.last_reply_check_at NULLS FIRST, m.sent_at, c.id`;

const inflight = new WeakMap(); // pool -> running sweep (single-flight, shared by poller and POST /sweep)

// Checks the inbox for replies. A failure is logged (ids/codes only) and never counts as "no
// reply". Returns { skipped } | { checked, replied, rowErrors, error? }.
export async function runSweep(args) {
  if (inflight.has(args.pool)) return { skipped: true, reason: "in_progress" };
  const running = doSweep(args);
  inflight.set(args.pool, running);
  try {
    return await running;
  } finally {
    inflight.delete(args.pool);
  }
}

async function doSweep({ pool, config, checkReply, openChecker, logger = console, shouldStop = () => false, now = () => new Date() }) {
  const injected = typeof checkReply === "function" || typeof openChecker === "function";
  if (config.dryRun && !injected) return { skipped: true, reason: "dry_run" };
  const startedAt = now();
  const prev = await readState(pool);
  const record = (patch) =>
    writeState(pool, { ...patch, at: startedAt.toISOString(), lastSuccessAt: patch.ok ? startedAt.toISOString() : (prev?.lastSuccessAt ?? null) });
  const summary = { checked: 0, replied: 0, rowErrors: 0 };
  const code = (err) => `${err?.name ?? "Error"} ${err?.code ?? ""}`.trim();

  let checker;
  try {
    checker =
      typeof checkReply === "function"
        ? { check: (id, o) => checkReply(config, id, o), close: async () => {} }
        : await (openChecker ?? createReplyChecker)(config);
  } catch (err) {
    logger.error(`reply sweep failed to connect: ${code(err)}`);
    await record({ ok: false, errorCode: String(err?.code ?? err?.name ?? "Error"), rowErrors: 0 });
    return { ...summary, error: true };
  }

  let fatal = null;
  let stopped = false;
  let candidates = 0;
  try {
    const since = new Date(startedAt.getTime() - SWEEP_WINDOW_DAYS * DAY_MS);
    const { rows } = await pool.query(CANDIDATES, [injected ? null : false, since]);
    candidates = rows.length;
    for (const row of rows) {
      if (shouldStop()) {
        stopped = true;
        break;
      }
      let found;
      try {
        found = await checker.check(row.message_id, {
          fromEmail: row.email,
          subject: row.subject,
          since: new Date(new Date(row.sent_at).getTime() - DAY_MS),
        });
      } catch (err) {
        if (isFatalSweepError(err)) {
          logger.error(`reply sweep failed: ${code(err)}`);
          fatal = err;
          break;
        }
        summary.rowErrors += 1;
        logger.error(`reply sweep row failed contact=${row.id} stage=check ${code(err)}`);
        await pool.query("UPDATE contacts SET last_reply_check_at = now() WHERE id = $1", [row.id]);
        continue;
      }
      summary.checked += 1;
      await pool.query("UPDATE contacts SET last_reply_check_at = now() WHERE id = $1", [row.id]);
      if (!found) continue;
      const hit = typeof found === "object" ? found : {};
      try {
        await markReplied(pool, row.id, { source: "imap", meta: { uid: hit.uid ?? null, via: hit.via ?? null } });
        summary.replied += 1;
      } catch (err) {
        // e.g. opted out between the SELECT and now; nothing to retry.
        logger.error(`reply sweep row failed contact=${row.id} stage=mark ${code(err)}`);
        // 404/409 are expected races (deleted / opted out meanwhile); anything else is a real failure.
        if (err?.status !== 404 && err?.status !== 409) summary.rowErrors += 1;
      }
    }
  } finally {
    await checker.close().catch(() => {});
  }
  if (stopped) return summary; // shutdown: say nothing about sweep health
  if (fatal) {
    await record({ ok: false, errorCode: String(fatal.code ?? fatal.name ?? "Error"), rowErrors: summary.rowErrors });
    return { ...summary, error: true };
  }
  await record({ ok: sweepOk({ candidates, checked: summary.checked, rowErrors: summary.rowErrors }), errorCode: null, rowErrors: summary.rowErrors });
  return summary;
}
