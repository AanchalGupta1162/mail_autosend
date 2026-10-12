import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";

const EXPECTED = ["batches", "contacts", "events", "messages", "schema_migrations", "settings", "suppressions", "users"];
let db;
let publicBefore;

async function tablesIn(pool, schema) {
  const { rows } = await pool.query(
    "select table_name from information_schema.tables where table_schema = $1 order by 1",
    [schema],
  );
  return rows.map((r) => r.table_name);
}

before(async () => {
  const admin = createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
  publicBefore = await tablesIn(admin, "public");
  await admin.end();
  db = await createTestDb();
});
after(async () => {
  await db?.close();
});

test("migrations create all tables in the test schema", async () => {
  assert.deepEqual(await tablesIn(db.pool, db.schema), EXPECTED);
});

test("migrate is idempotent", async () => {
  const again = await migrate(db.pool);
  assert.deepEqual(again.applied, []);
  const { rows } = await db.pool.query("select count(*)::int n from schema_migrations");
  assert.equal(rows[0].n, 1);
});

test("search_path is the test schema, nothing leaks into public", async () => {
  const { rows } = await db.pool.query("select current_schema() s");
  assert.equal(rows[0].s, db.schema);
  const admin = createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    assert.deepEqual(await tablesIn(admin, "public"), publicBefore);
  } finally {
    await admin.end();
  }
});

test("constraints: one live message per (contact, kind); unique email per batch", async () => {
  const { pool } = db;
  const b = (await pool.query("insert into batches(name) values('b') returning id")).rows[0].id;
  const c = (
    await pool.query(
      `insert into contacts(batch_id, company, role, person, email, subject, mail_text)
       values($1,'c','r','p','A@x.com','s','t') returning id`,
      [b],
    )
  ).rows[0].id;
  await assert.rejects(
    pool.query(
      `insert into contacts(batch_id, company, role, person, email, subject, mail_text)
       values($1,'c','r','p','a@X.com','s','t')`,
      [b],
    ),
    { code: "23505" },
  );
  const ins = `insert into messages(contact_id, kind, state, scheduled_for) values($1,'initial',$2, now())`;
  await pool.query(ins, [c, "scheduled"]);
  await assert.rejects(pool.query(ins, [c, "scheduled"]), { code: "23505" });
  await pool.query("update messages set state='cancelled' where contact_id=$1", [c]);
  await pool.query(ins, [c, "scheduled"]); // allowed once the old one is cancelled
  await assert.rejects(pool.query(ins, [c, "bogus"]), { code: "23514" });
});

test("default follow-up template is seeded", async () => {
  const { rows } = await db.pool.query("select value from settings where key='followup_template'");
  assert.equal(rows[0].value.subject, "Re: {{subject}}");
  assert.match(rows[0].value.body, /Harshavardhan Khamkar$/);
});

test("users: username unique case-insensitively", async () => {
  await db.pool.query("insert into users(username, password_hash) values('Admin','h')");
  await assert.rejects(db.pool.query("insert into users(username, password_hash) values('admin','h')"), {
    code: "23505",
  });
});
