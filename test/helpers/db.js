import { randomBytes } from "node:crypto";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";

// Creates a throwaway schema t_<random>, migrates it, and returns a pool whose
// search_path is that schema. close() drops the schema. Never touches `public`.
export async function createTestDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for DB tests");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = createPool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool({ connectionString, schema });
  try {
    await migrate(pool);
  } catch (err) {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    throw err;
  }
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
