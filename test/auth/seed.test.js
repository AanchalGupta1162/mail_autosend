import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import { seedAdmin } from "../../scripts/seedAdmin.js";
import { verifyPassword } from "../../src/auth/password.js";

let db;
before(async () => {
  db = await createTestDb();
});
after(async () => db?.close());

test("seedAdmin creates, then updates idempotently, and resets lockout", async () => {
  const first = await seedAdmin(db.pool, { username: "Boss", password: "first-password-1" });
  assert.equal(first, "created");
  await db.pool.query("update users set failed_attempts=5, locked_until=now()+interval '1 hour'");
  const second = await seedAdmin(db.pool, { username: "boss", password: "second-password-2" });
  assert.equal(second, "updated");
  const { rows } = await db.pool.query("select * from users");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].failed_attempts, 0);
  assert.equal(rows[0].locked_until, null);
  assert.ok(!rows[0].password_hash.includes("second-password"));
  assert.equal(await verifyPassword("second-password-2", rows[0].password_hash), true);
  assert.equal(await verifyPassword("first-password-1", rows[0].password_hash), false);
});
