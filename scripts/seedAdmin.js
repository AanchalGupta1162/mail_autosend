import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/password.js";
import { isPlaceholderValue } from "../src/server/env.js";

// Idempotent upsert keyed on lower(username). Also clears any lockout.
// Returns "created" | "updated". Never logs the password or hash.
export async function seedAdmin(pool, { username, password }) {
  // Defence in depth: the config loader already refuses this, but a direct caller must not seed a known password.
  if (isPlaceholderValue(password)) throw new Error("Invalid admin configuration: ADMIN_PASSWORD is still a placeholder value; add a real secret version");
  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (lower(username)) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL
     RETURNING (xmax = 0) AS inserted`,
    [username, hash],
  );
  return rows[0].inserted ? "created" : "updated";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadAdminSeedConfig } = await import("../src/server/env.js");
  const { createPool } = await import("../src/db/pool.js");
  const { migrate } = await import("../src/db/migrate.js");
  let pool;
  try {
    const admin = loadAdminSeedConfig();
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = createPool({ connectionString: process.env.DATABASE_URL, schema: process.env.DB_SCHEMA || "public", max: 1 });
    await migrate(pool);
    const result = await seedAdmin(pool, admin);
    console.log(`admin ${result}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
