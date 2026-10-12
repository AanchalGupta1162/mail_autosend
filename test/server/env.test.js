import { test } from "node:test";
import assert from "node:assert/strict";
import { loadServerConfig, loadAdminSeedConfig } from "../../src/server/env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  SESSION_SECRET: "x".repeat(32),
};

test("applies defaults", () => {
  const c = loadServerConfig(base);
  assert.equal(c.port, 3000);
  assert.equal(c.dryRun, true);
  assert.equal(c.dailySendCap, 100);
  assert.equal(c.maxPerTick, 5);
  assert.equal(c.sendGapSecondsMin, 15);
  assert.equal(c.sendGapSecondsMax, 45);
  assert.equal(c.trustProxy, false);
  assert.equal(c.nodeEnv, "development");
});

test("rejects a short SESSION_SECRET", () => {
  assert.throws(() => loadServerConfig({ ...base, SESSION_SECRET: "short" }), /SESSION_SECRET/);
});

test("rejects missing DATABASE_URL and SESSION_SECRET", () => {
  assert.throws(() => loadServerConfig({ SESSION_SECRET: base.SESSION_SECRET }), /DATABASE_URL/);
  assert.throws(() => loadServerConfig({ DATABASE_URL: base.DATABASE_URL }), /SESSION_SECRET/);
});

test("parses overrides and flags", () => {
  const c = loadServerConfig({
    ...base,
    NODE_ENV: "production",
    PORT: "8080",
    DRY_RUN: "false",
    TRUST_PROXY: "1",
    DAILY_SEND_CAP: "20",
    MAX_PER_TICK: "2",
    SEND_GAP_SECONDS_MIN: "1",
    SEND_GAP_SECONDS_MAX: "2",
    GMAIL_USER: "a@gmail.com",
    GMAIL_APP_PASSWORD: "pw",
  });
  assert.equal(c.port, 8080);
  assert.equal(c.dryRun, false);
  assert.equal(c.trustProxy, true);
  assert.equal(c.nodeEnv, "production");
  assert.equal(c.dailySendCap, 20);
  assert.equal(c.gmailUser, "a@gmail.com");
});

test("rejects invalid values", () => {
  assert.throws(() => loadServerConfig({ ...base, PORT: "abc" }), /PORT/);
  assert.throws(() => loadServerConfig({ ...base, NODE_ENV: "weird" }), /NODE_ENV/);
  assert.throws(
    () => loadServerConfig({ ...base, SEND_GAP_SECONDS_MIN: "50", SEND_GAP_SECONDS_MAX: "10" }),
    /SEND_GAP/,
  );
});

test("error message never leaks the secret value", () => {
  try {
    loadServerConfig({ ...base, SESSION_SECRET: "tooshortsecret" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!e.message.includes("tooshortsecret"));
  }
});

test("DRY_RUN accepts only explicit boolean spellings", () => {
  for (const v of ["true", "TRUE", "1", "yes", "Yes"]) {
    assert.equal(loadServerConfig({ ...base, DRY_RUN: v }).dryRun, true, v);
  }
  const creds = { GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "pw" };
  for (const v of ["false", "FALSE", "0", "no", "No"]) {
    assert.equal(loadServerConfig({ ...base, ...creds, DRY_RUN: v }).dryRun, false, v);
  }
});

test("DRY_RUN typo is rejected, naming the variable but not the value", () => {
  const creds = { GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "pw" };
  for (const v of ["ture", "flase", "off", "2"]) {
    assert.throws(
      () => loadServerConfig({ ...base, ...creds, DRY_RUN: v }),
      (e) => /DRY_RUN/.test(e.message) && !e.message.includes(v),
      v,
    );
  }
});

test(".env.example placeholders are rejected by validation", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const get = (k) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1].trim() ?? "";
  assert.throws(
    () => loadServerConfig({ DATABASE_URL: get("DATABASE_URL"), SESSION_SECRET: get("SESSION_SECRET") }),
    /SESSION_SECRET/,
  );
  assert.throws(
    () => loadAdminSeedConfig({ ADMIN_USERNAME: get("ADMIN_USERNAME"), ADMIN_PASSWORD: get("ADMIN_PASSWORD") }),
    /ADMIN_PASSWORD/,
  );
});

test("loadAdminSeedConfig validates username and password", () => {
  const ok = loadAdminSeedConfig({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "abcdefghij" });
  assert.deepEqual(ok, { username: "admin", password: "abcdefghij" });
  assert.throws(() => loadAdminSeedConfig({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "" }), /ADMIN_PASSWORD/);
  assert.throws(() => loadAdminSeedConfig({ ADMIN_USERNAME: "admin" }), /ADMIN_PASSWORD/);
  assert.throws(
    () => loadAdminSeedConfig({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "123456789" }),
    (e) => /ADMIN_PASSWORD/.test(e.message) && !e.message.includes("123456789"),
  );
  for (const u of ["ab", "ad min", "adm\nin", ""]) {
    assert.throws(() => loadAdminSeedConfig({ ADMIN_USERNAME: u, ADMIN_PASSWORD: "abcdefghij" }), /ADMIN_USERNAME/, JSON.stringify(u));
  }
});

test("POLL_INTERVAL_SECONDS defaults to 30 and must be a positive integer", () => {
  assert.equal(loadServerConfig(base).pollIntervalSeconds, 30);
  assert.equal(loadServerConfig({ ...base, POLL_INTERVAL_SECONDS: "5" }).pollIntervalSeconds, 5);
  assert.throws(() => loadServerConfig({ ...base, POLL_INTERVAL_SECONDS: "0" }), /POLL_INTERVAL_SECONDS/);
});
