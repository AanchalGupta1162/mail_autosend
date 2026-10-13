import { loadServerConfig } from "./env.js";
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "./app.js";
import { createMailer } from "../mailer.js";
import { createPoller, stopWorkers } from "../worker/poller.js";
import { runTick } from "../worker/tick.js";
import { runSweep } from "../worker/sweep.js";

const SWEEP_INTERVAL_MS = 10 * 60_000;

let config;
try {
  config = loadServerConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const pool = createPool({
  connectionString: config.databaseUrl,
  schema: process.env.DB_SCHEMA || "public",
});
await migrate(pool);

const mailer = createMailer(config);
const app = createApp({ pool, config, mailer });
const server = app.listen(config.port, () => console.log(`Listening on port ${config.port}`));

// The send worker runs in this process, never under test (tests call runTick directly).
const poller =
  config.nodeEnv === "test"
    ? null
    : createPoller({
        intervalMs: config.pollIntervalSeconds * 1000,
        run: ({ shouldStop, signal }) => runTick({ pool, mailer, config, shouldStop, signal }),
      });

// Reply sweep on its own loop so a slow IMAP run can never delay claiming/sending. Real mode
// only (dry-run has no inbox). Single-flight with POST /sweep via runSweep. Started before the
// send loop so fresh reply data exists when the first tick considers follow-ups.
const sweepPoller =
  poller && !config.dryRun && config.replySweepEnabled
    ? createPoller({ intervalMs: SWEEP_INTERVAL_MS, run: ({ shouldStop }) => runSweep({ pool, config, shouldStop }) })
    : null;
sweepPoller?.start();
poller?.start();
console.log(`Send worker ${poller ? `polling every ${config.pollIntervalSeconds}s` : "disabled"} (DRY_RUN=${config.dryRun})`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 120_000).unref(); // hard stop if a send hangs
  await stopWorkers(poller, sweepPoller); // lets an in-flight send finish and be recorded
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
