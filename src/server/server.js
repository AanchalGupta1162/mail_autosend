import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "./env.js";
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "./app.js";
import { createMailer } from "../mailer.js";
import { createPoller, intervalGate } from "../worker/poller.js";
import { runTick } from "../worker/tick.js";
import { runSweep } from "../worker/sweep.js";

const SWEEP_INTERVAL_MS = 10 * 60_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
const app = createApp({ pool, config, mailer, staticDir: path.join(root, "web", "dist") });
const server = app.listen(config.port, () => console.log(`Listening on port ${config.port}`));

// Reply sweep: at most every 10 minutes, real mode only (dry-run has no inbox to check).
const sweepGate = intervalGate(SWEEP_INTERVAL_MS, ({ shouldStop }) => runSweep({ pool, config, shouldStop }));

// The send worker runs in this process, never under test (tests call runTick directly).
const poller =
  config.nodeEnv === "test"
    ? null
    : createPoller({
        intervalMs: config.pollIntervalSeconds * 1000,
        run: async ({ shouldStop, signal }) => {
          await runTick({ pool, mailer, config, shouldStop, signal });
          if (!config.dryRun && !shouldStop()) await sweepGate({ shouldStop });
        },
      });
poller?.start();
console.log(`Send worker ${poller ? `polling every ${config.pollIntervalSeconds}s` : "disabled"} (DRY_RUN=${config.dryRun})`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 120_000).unref(); // hard stop if a send hangs
  await poller?.stop(); // lets an in-flight send finish and be recorded
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
