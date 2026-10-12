import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_KEY = 727_001; // advisory lock so concurrent migrators serialize

// Applies pending *.sql migrations in filename order, each in its own transaction.
// Tracks them in schema_migrations (resolved through the pool's search_path).
export async function migrate(pool, dir = DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      applied.push(file);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    } finally {
      client.release();
    }
  }
  return { applied };
}

// CLI: `npm run migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createPool } = await import("./pool.js");
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { applied } = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
    );
    console.log("Tables:", rows.map((r) => r.table_name).join(", "));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
