import { Router } from "express";
import { followupSendsAllowed, runSweep } from "../../worker/sweep.js";

const DAY_MS = 86_400_000;

// A fixed number of aggregate queries (no per-row follow-ups), run concurrently.
export async function loadDashboard(pool, config) {
  const since = new Date(Date.now() - DAY_MS);
  const [totals, sent, rate, upcoming, events, companies, sweepState, allowed] = await Promise.all([
    pool.query("SELECT status, count(*)::int AS n FROM contacts GROUP BY status"),
    // Same accounting as the send cap in tick.js (sent, in flight, recent needs_review).
    pool.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE dry_run = $1
          AND ((state = 'sent' AND sent_at > $2) OR state = 'sending' OR (state = 'needs_review' AND claimed_at > $2))`,
      [Boolean(config.dryRun), since],
    ),
    pool.query(
      `SELECT count(*)::int AS contacted, count(*) FILTER (WHERE c.status = 'replied')::int AS replied
         FROM contacts c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.kind = 'initial' AND m.state = 'sent')`,
    ),
    pool.query(
      `SELECT m.id, m.contact_id, m.kind, m.scheduled_for, c.email, c.company, c.person
         FROM messages m JOIN contacts c ON c.id = m.contact_id
        WHERE m.state = 'scheduled' ORDER BY m.scheduled_for, m.id LIMIT 10`,
    ),
    pool.query(
      `SELECT e.id, e.contact_id, e.type, e.meta, e.at, c.email
         FROM events e LEFT JOIN contacts c ON c.id = e.contact_id ORDER BY e.at DESC, e.id DESC LIMIT 20`,
    ),
    pool.query(
      `SELECT c.company, count(*)::int AS total,
              count(*) FILTER (WHERE c.status IN ('sent','replied'))::int AS sent,
              count(*) FILTER (WHERE c.status = 'replied')::int AS replied
         FROM contacts c GROUP BY c.company ORDER BY total DESC, c.company LIMIT 10`,
    ),
    pool.query("SELECT value FROM settings WHERE key = 'sweep_state'"),
    followupSendsAllowed(pool, config, new Date()),
  ]);
  const byStatus = { uploaded: 0, scheduled: 0, sent: 0, replied: 0, bounced: 0, opted_out: 0, failed: 0 };
  for (const r of totals.rows) byStatus[r.status] = r.n;
  const { contacted, replied } = rate.rows[0];
  return {
    totals: byStatus,
    sentToday: sent.rows[0].n,
    dailyCap: config.dailySendCap,
    repliedRate: contacted ? +(replied / contacted).toFixed(4) : 0,
    upcoming: upcoming.rows.map((r) => ({
      messageId: r.id, contactId: r.contact_id, kind: r.kind, scheduledFor: r.scheduled_for,
      email: r.email, company: r.company, person: r.person,
    })),
    recentEvents: events.rows.map((r) => ({ id: Number(r.id), contactId: r.contact_id, type: r.type, meta: r.meta, at: r.at, email: r.email })),
    byCompany: companies.rows,
    sweep: sweepState.rows[0]?.value ?? null,
    followupsHeld: !allowed,
  };
}

export function dashboardRouter({ pool, config, checkReply, logger }) {
  const router = Router();

  router.get("/dashboard", async (_req, res, next) => {
    try {
      res.json(await loadDashboard(pool, config));
    } catch (err) {
      next(err);
    }
  });

  router.post("/sweep", async (_req, res, next) => {
    try {
      res.json(await runSweep({ pool, config, checkReply, logger }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
