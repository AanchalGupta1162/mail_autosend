import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, directConnectionString } from "../helpers/db.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";

const EXPECTED = ["batches", "contacts", "events", "messages", "resumes", "schema_migrations", "session", "settings", "suppressions", "users"];
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
  assert.equal(rows[0].n, 4);
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

test("concurrent migrators serialize and leave no session-level advisory lock behind", async () => {
  const schema = db.schema;
  const p2 = createPool({ connectionString: directConnectionString(), schema });
  const p3 = createPool({ connectionString: directConnectionString(), schema });
  // Only look at THIS test's connections: other test files migrate their own schemas in
  // parallel and legitimately hold the same advisory lock for a moment.
  const pids = new Set();
  for (const p of [p2, p3]) p.on("connect", (c) => pids.add(c.processID));
  try {
    const [a, b] = await Promise.all([migrate(p2), migrate(p3)]);
    assert.deepEqual([...a.applied, ...b.applied], []);
    const { rows } = await db.pool.query(
      "select count(*)::int n from pg_locks where locktype='advisory' and objid=727001 and granted and pid = any($1::int[])",
      [[...pids]],
    );
    assert.ok(pids.size > 0);
    assert.equal(rows[0].n, 0);
  } finally {
    await p2.end();
    await p3.end();
  }
});

test("migration 003 can be re-applied safely (IF NOT EXISTS)", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../src/db/migrations/003_reply_check.sql", import.meta.url), "utf8");
  await db.pool.query(sql);
  await db.pool.query(sql);
});

test("resumes: at most one live default, display names unique among live rows, choice columns exist", async () => {
  const { pool } = db;
  const ins = (name, def = false, deleted = false) =>
    pool.query(
      `insert into resumes(display_name, file_name, storage_key, generation, size_bytes, sha256, is_default, deleted_at)
       values($1,'r.pdf','k-'||gen_random_uuid(),'1',10,'ab',$2,$3) returning id`,
      [name, def, deleted ? new Date() : null],
    );
  await ins("General", true);
  await assert.rejects(ins("Other", true), /resumes_one_default_idx/);
  await assert.rejects(ins("general"), /resumes_live_name_idx/);
  await ins("General", false, true); // a soft-deleted row does not hold the name
  await ins("Deleted default", true, true); // nor the default slot
  for (const [table, col] of [["batches", "resume_id"], ["contacts", "resume_id"], ["messages", "resume_id"], ["messages", "resume_generation"]]) {
    const { rows } = await pool.query("select 1 from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2", [table, col]);
    assert.equal(rows.length, 1, `${table}.${col}`);
  }
});
