import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_KEY = 727_001; // advisory lock so concurrent migrators serialize

export const errorLabel = (err) => `${err?.name ?? "Error"} ${err?.code ?? ""}`.trim();

// Applies pending *.sql migrations in filename order, each in its own transaction.
// Tracks them in schema_migrations (resolved through the pool's search_path).
// Serialized with a TRANSACTION-scoped advisory lock: it is released by COMMIT/ROLLBACK
// (even if the client dies or the connection is pooled), unlike a session-level lock
// which can leak onto a pooled backend and block every later migrator.
export async function migrate(pool, dir = DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
        await client.query(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
             name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if (done.rowCount) {
          await client.query("COMMIT");
          continue;
        }
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // name/code only: a driver message can carry connection details.
        throw new Error(`Migration ${file} failed: ${errorLabel(err)}`);
      }
      applied.push(file);
    }
  } finally {
    client.release();
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
  // Explicit schema: some Postgres roles have no default search_path.
  const pool = createPool({ connectionString: process.env.DATABASE_URL, schema: process.env.DB_SCHEMA || "public", max: 1 });
  try {
    const { applied } = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date.");
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
    );
    console.log("Tables:", rows.map((r) => r.table_name).join(", "));
  } catch (err) {
    // Wrapped migration errors are already name/code only; anything else (connect, auth) is reduced the same way.
    console.error(/^Migration .+ failed: /.test(err?.message ?? "") ? err.message : `Migration run failed: ${errorLabel(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
