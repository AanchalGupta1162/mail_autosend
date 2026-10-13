import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { runTick } from "../../worker/tick.js";
import { runSweep } from "../../worker/sweep.js";

const MAX_ITERATIONS = 1000; // belt and braces: a loop that claims forever is a bug, not a workload
const SUMMARY_KEYS = ["staleRecovered", "claimed", "sent", "cancelled", "held", "retried", "failed", "needsReview"];

// Production verifier: Google-signed OIDC ID token, checked for signature, expiry, issuer and audience.
// Certificates are fetched from Google (cached by the client); nothing here runs in tests.
export function createGoogleVerifier(client = new OAuth2Client()) {
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return ticket.getPayload();
  };
}

// Cloud Scheduler authenticates with an OIDC token minted for one service account. Reject anything
// that is not exactly that account: 401 = no/invalid token, 403 = valid token, wrong caller.
// Responses never say why. An unconfigured service refuses everything.
function requireInvoker({ config, verify, logger }) {
  return async (req, res, next) => {
    const deny = (status, error, reason) => {
      logger.warn("internal request rejected", { event: "internal_auth_rejected", path: req.path, status, reason });
      res.status(status).json({ error });
    };
    if (!config.internalAudience || !config.internalInvokerSa) return deny(401, "Unauthorized", "not_configured");
    const m = /^Bearer ([^\s]+)$/.exec(req.get("authorization") ?? "");
    if (!m) return deny(401, "Unauthorized", "missing_bearer");
    let payload;
    try {
      payload = await verify(m[1], config.internalAudience);
    } catch {
      return deny(401, "Unauthorized", "invalid_token");
    }
    const email = typeof payload?.email === "string" ? payload.email : "";
    if (payload?.email_verified !== true || email !== config.internalInvokerSa) return deny(403, "Forbidden", "wrong_caller");
    next();
  };
}

const emptySummary = () => Object.fromEntries(SUMMARY_KEYS.map((k) => [k, 0]));

// Mounted on /internal BEFORE session, CSRF and body parsing, so these routes are reachable only with an
// OIDC token and never through a browser session. Nothing else is exempt from the session/CSRF guards.
export function internalRouter({ pool, config, mailer, checkReply, logger, verify = createGoogleVerifier(), shutdownSignal, now = () => new Date() }) {
  const router = Router();
  router.use(requireInvoker({ config, verify, logger }));
  let tickRunning = false;

  // Drains the queue: runTick until nothing is claimed, the send window closes, the deadline passes, the
  // service is shutting down, or sending is paused by a hold. Pacing (random gaps) stays inside runTick.
  router.post("/tick", async (_req, res, next) => {
    if (tickRunning) return res.json({ ok: true, skipped: true, reason: "in_progress" });
    tickRunning = true;
    try {
      const deadlineMs = now().getTime() + config.internalTickDeadlineSeconds * 1000;
      const timeLeft = () => Math.max(0, deadlineMs - now().getTime());
      const shuttingDown = () => Boolean(shutdownSignal?.aborted);
      const pastDeadline = () => timeLeft() <= 0;
      const signal = AbortSignal.any([...(shutdownSignal ? [shutdownSignal] : []), AbortSignal.timeout(timeLeft())]);
      const summary = emptySummary();
      let iterations = 0;
      let reason = "idle";
      while (true) {
        if (shuttingDown()) { reason = "shutdown"; break; }
        if (pastDeadline()) { reason = "deadline"; break; }
        if (iterations >= MAX_ITERATIONS) { reason = "iteration_cap"; break; }
        const r = await runTick({ pool, mailer, config, logger, signal, shouldStop: () => shuttingDown() || pastDeadline() });
        iterations += 1;
        for (const k of SUMMARY_KEYS) summary[k] += r[k] ?? 0;
        if (shuttingDown()) { reason = "shutdown"; break; }
        if (r.outsideWindow) { reason = "window_closed"; break; }
        if (r.paused) { reason = "paused"; break; }
        if (pastDeadline()) { reason = "deadline"; break; }
        if (!r.claimed) { reason = "idle"; break; }
      }
      logger.info("internal tick finished", { event: "internal_tick", reason, iterations, ...summary });
      res.json({ ok: true, reason, iterations, summary });
    } catch (err) {
      next(err);
    } finally {
      tickRunning = false;
    }
  });

  // runSweep is already single-flight per pool (shared with the in-process poller and POST /api/sweep):
  // an overlapping call returns 200 {skipped: in_progress}, not an error, so Cloud Scheduler does not retry it.
  router.post("/sweep", async (_req, res, next) => {
    try {
      const result = await runSweep({ pool, config, checkReply, logger, shouldStop: () => Boolean(shutdownSignal?.aborted) });
      logger.info("internal sweep finished", { event: "internal_sweep", ...result });
      res.json({ ok: true, result });
    } catch (err) {
      next(err);
    }
  });

  router.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return router;
}
