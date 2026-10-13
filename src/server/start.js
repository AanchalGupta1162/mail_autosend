import { migrate as defaultMigrate } from "../db/migrate.js";
import { createApp } from "./app.js";
import { createMailer } from "../mailer.js";
import { createPoller as defaultCreatePoller, stopWorkers } from "../worker/poller.js";
import { runTick } from "../worker/tick.js";
import { runSweep } from "../worker/sweep.js";

const SWEEP_INTERVAL_MS = 10 * 60_000;

// In-process workers. WORKER_MODE=scheduled (Cloud Run scaled to zero, woken by Cloud Scheduler through
// /internal/*) starts none: an idle instance must not hold timers, and the platform decides when work runs.
// Never under test either (tests call runTick directly).
export function createWorkers({ config, pool, mailer, logger, createPoller = defaultCreatePoller }) {
  if (config.workerMode === "scheduled" || config.nodeEnv === "test") return { poller: null, sweepPoller: null };
  const poller = createPoller({
    intervalMs: config.pollIntervalSeconds * 1000,
    logger,
    run: async ({ shouldStop, signal }) => {
      const r = await runTick({ pool, mailer, config, logger, shouldStop, signal });
      if (r.claimed || r.staleRecovered) logger.info("send tick finished", { event: "tick", ...r });
    },
  });
  // Reply sweep on its own loop so a slow IMAP run can never delay claiming/sending. Real mode only
  // (dry-run has no inbox). Single-flight with POST /sweep via runSweep.
  const sweepPoller =
    !config.dryRun && config.replySweepEnabled
      ? createPoller({ intervalMs: SWEEP_INTERVAL_MS, logger, run: ({ shouldStop }) => runSweep({ pool, config, logger, shouldStop }) })
      : null;
  return { poller, sweepPoller };
}

// Wires migrations, HTTP and workers. The caller owns the pool and the process lifecycle;
// close() stops accepting work, lets an in-flight send finish and be recorded, then closes HTTP.
export async function startServer({ config, pool, logger = console, migrate = defaultMigrate, createPoller, listenPort = config.port, mailer = createMailer(config) }) {
  if (config.migrateOnStart) await migrate(pool);
  const shutdown = new AbortController();
  const app = createApp({ pool, config, mailer, logger, shutdownSignal: shutdown.signal });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(listenPort, () => resolve(s));
    s.once("error", reject);
  });
  const workers = createWorkers({ config, pool, mailer, logger, createPoller });
  // Sweep first so fresh reply data exists when the first tick considers follow-ups.
  workers.sweepPoller?.start();
  workers.poller?.start();

  let closing = null;
  const close = () =>
    (closing ??= (async () => {
      shutdown.abort(); // wakes /internal/* loops and jitter sleeps
      await stopWorkers(workers.poller, workers.sweepPoller);
      await new Promise((resolve) => server.close(() => resolve()));
    })());
  return { server, workers, shutdownSignal: shutdown.signal, close };
}
