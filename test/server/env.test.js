import { test } from "node:test";
import assert from "node:assert/strict";
import { loadServerConfig } from "../../src/server/env.js";

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
