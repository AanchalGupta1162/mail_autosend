import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { createTestDb, directConnectionString } from "../helpers/db.js";

const run = promisify(execFile);
let db;
before(async () => {
  db = await createTestDb();
});
after(async () => db?.close());

test("src/db/migrate.js runs as a standalone entrypoint (the Cloud Run migrate job) and is idempotent", async () => {
  const { stdout } = await run(process.execPath, ["src/db/migrate.js"], {
    env: { PATH: process.env.PATH, DATABASE_URL: directConnectionString(), DB_SCHEMA: db.schema },
  });
  assert.match(stdout, /Up to date\./);
  assert.match(stdout, /Tables:.*messages/);
});

test("migrate.js refuses to run without DATABASE_URL", async () => {
  await assert.rejects(run(process.execPath, ["src/db/migrate.js"], { env: { PATH: process.env.PATH } }), (e) => e.code === 1 && /DATABASE_URL is required/.test(e.stderr));
});

const lines = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

test("docker build contexts exclude secrets, real data and dev-only trees but keep what the image needs", () => {
  const root = lines(".dockerignore");
  for (const want of [".env", ".env.*", ".git", ".superpowers", ".impeccable", "test", "docs", "attachments", "signature.html", "infra", "node_modules"]) {
    assert.ok(root.includes(want), `root .dockerignore lists ${want}`);
  }
  for (const needed of ["src", "scripts", "package.json", "package-lock.json"]) assert.ok(!root.includes(needed), `${needed} must stay in the context`);
  const web = lines("web/.dockerignore");
  for (const want of [".env", ".env.*", ".git", ".superpowers", ".impeccable", "docs", "attachments", "signature.html", "infra", "node_modules", ".next"]) {
    assert.ok(web.includes(want), `web/.dockerignore lists ${want}`);
  }
});

test("the backend image copies src (migrations + migrate.js) and scripts, runs non-root with a healthcheck", () => {
  const df = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(df, /COPY --chown=node:node src \.\/src/);
  assert.match(df, /COPY --chown=node:node scripts \.\/scripts/);
  assert.match(df, /^USER node$/m);
  assert.match(df, /^HEALTHCHECK /m);
});

test("both Dockerfiles pin the node base image by digest", () => {
  for (const f of ["Dockerfile", "web/Dockerfile"]) {
    const froms = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8").split("\n").filter((l) => /^FROM /.test(l));
    assert.ok(froms.length > 0);
    for (const l of froms) assert.match(l, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64} AS \w+$/, `${f}: ${l}`);
  }
});

test("migrate failures log only the error name/code, never the message (it can carry the connection string)", async () => {
  const url = "postgres://leak_user:s3cr3t_pw@127.0.0.1:1/db";
  await assert.rejects(
    run(process.execPath, ["src/db/migrate.js"], { env: { PATH: process.env.PATH, DATABASE_URL: url } }),
    (e) => e.code === 1 && /Error|ECONNREFUSED/.test(e.stderr) && !/s3cr3t_pw|leak_user|127\.0\.0\.1/.test(e.stderr),
  );
});

test("a failing migration reports its file and error code, not the database message", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { default: path } = await import("node:path");
  const { migrate } = await import("../../src/db/migrate.js");
  const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
  await writeFile(path.join(dir, "001_bad.sql"), "SELECT * FROM table_with_secret_name_xyz;");
  await assert.rejects(migrate(db.pool, dir), (e) => /001_bad\.sql/.test(e.message) && /42P01/.test(e.message) && !/table_with_secret_name_xyz/.test(e.message));
});
