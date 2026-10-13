import { loadServerConfig } from "./env.js";
import { createPool } from "../db/pool.js";
import { startServer } from "./start.js";
import { createJsonLogger } from "../logger.js";

const logger = createJsonLogger();

let config;
try {
  config = loadServerConfig();
} catch (err) {
  logger.error(err.message, { event: "config_invalid" }); // names variables, never values
  process.exit(1);
}

const pool = createPool({
  connectionString: config.databaseUrl,
  schema: process.env.DB_SCHEMA || "public",
});

const running = await startServer({ config, pool, logger });
logger.info("listening", { event: "listening", port: config.port });
logger.info("workers", {
  event: "workers",
  mode: config.workerMode,
  sendPoller: Boolean(running.workers.poller),
  sweepPoller: Boolean(running.workers.sweepPoller),
  pollIntervalSeconds: config.pollIntervalSeconds,
  dryRun: config.dryRun,
  migrateOnStart: config.migrateOnStart,
  sendWindowEnforced: config.sendWindowEnforced,
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(0), 120_000).unref(); // hard stop if a send hangs
  await running.close(); // lets an in-flight send finish and be recorded
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
