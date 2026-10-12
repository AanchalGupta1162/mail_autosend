import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "./env.js";
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "./app.js";

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

const app = createApp({ pool, config, staticDir: path.join(root, "web", "dist") });
const server = app.listen(config.port, () => console.log(`Listening on port ${config.port}`));

async function shutdown() {
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
