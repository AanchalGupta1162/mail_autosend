import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadServerConfig, loadAdminSeedConfig } from "../../src/server/env.js";

const files = { SIGNATURE_PATH: path.resolve("test/fixtures/sig-fixture.html"), RESUME_PATH: path.resolve("test/fixtures/resume.pdf") };
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
  assert.equal(c.trustProxy, 0);
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
    ...files,
  });
  assert.equal(c.port, 8080);
  assert.equal(c.dryRun, false);
  assert.equal(c.trustProxy, 1);
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
  const creds = { GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "pw", ...files };
  for (const v of ["false", "FALSE", "0", "no", "No"]) {
    assert.equal(loadServerConfig({ ...base, ...creds, DRY_RUN: v }).dryRun, false, v);
  }
});

test("DRY_RUN typo is rejected, naming the variable but not the value", () => {
  const creds = { GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "pw", ...files };
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

test("REPLY_SWEEP_ENABLED defaults to true and can be turned off", () => {
  assert.equal(loadServerConfig(base).replySweepEnabled, true);
  assert.equal(loadServerConfig({ ...base, REPLY_SWEEP_ENABLED: "false" }).replySweepEnabled, false);
});

test("real mode fails fast when SIGNATURE_PATH or RESUME_PATH is missing, unset or not a file; dry-run does not care", () => {
  const real = { ...base, GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "pw", DRY_RUN: "false" };
  assert.doesNotThrow(() => loadServerConfig({ ...real, ...files }));
  assert.throws(() => loadServerConfig({ ...real, ...files, SIGNATURE_PATH: "" }), /SIGNATURE_PATH/);
  // RESUME_PATH is only the legacy fallback now (the resume library is primary): optional, but if set it must exist.
  assert.doesNotThrow(() => loadServerConfig({ ...real, ...files, RESUME_PATH: undefined }));
  assert.throws(() => loadServerConfig({ ...real, ...files, SIGNATURE_PATH: "/nonexistent/sig.html" }), (e) => /SIGNATURE_PATH/.test(e.message) && !e.message.includes("/nonexistent"));
  assert.throws(() => loadServerConfig({ ...real, ...files, RESUME_PATH: "/nonexistent/r.pdf" }), /RESUME_PATH/);
  assert.doesNotThrow(() => loadServerConfig({ ...base, SIGNATURE_PATH: "/nonexistent/sig.html" }));
});

test("TRUST_PROXY is a proxy hop count: 0/false/empty = off, 1..5 = that many hops, anything else is refused", () => {
  const hops = (v) => loadServerConfig({ ...base, TRUST_PROXY: v }).trustProxy;
  for (const off of ["", "0", "false"]) assert.equal(hops(off), 0);
  assert.equal(hops("1"), 1);
  assert.equal(hops("2"), 2);
  // "true" would trust every X-Forwarded-For entry, so any client could pick its own IP.
  for (const bad of ["true", "yes", "-1", "6", "1.5", "abc", "loopback", "10.0.0.0/8"]) {
    assert.throws(() => hops(bad), /TRUST_PROXY/, bad);
  }
});

test("resume storage: local by default, gcs needs a bucket, anything else is refused", () => {
  const c = loadServerConfig(base);
  assert.equal(c.resumeStorage, "local");
  assert.equal(c.resumeLocalDir, "./data/resumes");
  assert.equal(c.resumeBucket, undefined);
  assert.equal(loadServerConfig({ ...base, RESUME_LOCAL_DIR: " /tmp/r " }).resumeLocalDir, "/tmp/r");
  assert.throws(() => loadServerConfig({ ...base, RESUME_STORAGE: "gcs" }), /RESUME_BUCKET/);
  assert.throws(() => loadServerConfig({ ...base, RESUME_STORAGE: "gcs", RESUME_BUCKET: "Bad_Bucket!" }), /RESUME_BUCKET/);
  const g = loadServerConfig({ ...base, RESUME_STORAGE: "gcs", RESUME_BUCKET: "my-resumes-bucket" });
  assert.equal(g.resumeStorage, "gcs");
  assert.equal(g.resumeBucket, "my-resumes-bucket");
  assert.throws(() => loadServerConfig({ ...base, RESUME_STORAGE: "s3" }), /RESUME_STORAGE/);
});

// --- scale-to-zero settings ----------------------------------------------------------------
test("scale-to-zero defaults keep local dev unchanged", () => {
  const c = loadServerConfig(base);
  assert.equal(c.workerMode, "polling");
  assert.equal(c.migrateOnStart, true);
  assert.equal(c.sendWindowEnforced, false);
  assert.equal(c.sweepMaxAgeMinutes, 90);
  assert.equal(c.internalTickDeadlineSeconds, 480);
  assert.equal(c.signatureHtml, undefined);
  assert.equal(c.internalAudience, undefined);
  assert.equal(c.internalInvokerSa, undefined);
});

test("WORKER_MODE accepts polling|scheduled only; scheduled needs the internal auth settings", () => {
  const internal = { INTERNAL_AUDIENCE: "https://backend.example.run.app", INTERNAL_INVOKER_SA: "inv@p.iam.gserviceaccount.com" };
  assert.equal(loadServerConfig({ ...base, WORKER_MODE: "polling" }).workerMode, "polling");
  assert.equal(loadServerConfig({ ...base, WORKER_MODE: "scheduled", ...internal }).workerMode, "scheduled");
  assert.throws(() => loadServerConfig({ ...base, WORKER_MODE: "cron" }), (e) => /WORKER_MODE/.test(e.message) && !e.message.includes("cron"));
  assert.throws(() => loadServerConfig({ ...base, WORKER_MODE: "scheduled" }), /INTERNAL_AUDIENCE/);
  assert.throws(() => loadServerConfig({ ...base, WORKER_MODE: "scheduled", INTERNAL_AUDIENCE: internal.INTERNAL_AUDIENCE }), /INTERNAL_INVOKER_SA/);
});

test("SWEEP_MAX_AGE_MINUTES is an integer 5..1440", () => {
  assert.equal(loadServerConfig({ ...base, SWEEP_MAX_AGE_MINUTES: "5" }).sweepMaxAgeMinutes, 5);
  assert.equal(loadServerConfig({ ...base, SWEEP_MAX_AGE_MINUTES: "1440" }).sweepMaxAgeMinutes, 1440);
  for (const v of ["4", "1441", "x", "1.5"]) assert.throws(() => loadServerConfig({ ...base, SWEEP_MAX_AGE_MINUTES: v }), /SWEEP_MAX_AGE_MINUTES/, v);
});

test("INTERNAL_TICK_DEADLINE_SECONDS defaults to 480 (480 + a 90 s in-flight send stays under the 600 s Scheduler attempt deadline)", () => {
  assert.equal(loadServerConfig({ ...base }).internalTickDeadlineSeconds, 480);
});

test("INTERNAL_TICK_DEADLINE_SECONDS, SEND_WINDOW_ENFORCED and MIGRATE_ON_START parse", () => {
  const c = loadServerConfig({ ...base, INTERNAL_TICK_DEADLINE_SECONDS: "60", SEND_WINDOW_ENFORCED: "true", MIGRATE_ON_START: "false" });
  assert.equal(c.internalTickDeadlineSeconds, 60);
  assert.equal(c.sendWindowEnforced, true);
  assert.equal(c.migrateOnStart, false);
  assert.throws(() => loadServerConfig({ ...base, INTERNAL_TICK_DEADLINE_SECONDS: "0" }), /INTERNAL_TICK_DEADLINE_SECONDS/);
  assert.throws(() => loadServerConfig({ ...base, MIGRATE_ON_START: "maybe" }), /MIGRATE_ON_START/);
});

test("SIGNATURE_HTML replaces SIGNATURE_PATH in real-mode validation and is size-capped", () => {
  const creds = { GMAIL_USER: "a@gmail.com", GMAIL_APP_PASSWORD: "pw", DRY_RUN: "false", RESUME_PATH: files.RESUME_PATH };
  assert.throws(() => loadServerConfig({ ...base, ...creds }), /SIGNATURE_PATH/);
  const c = loadServerConfig({ ...base, ...creds, SIGNATURE_HTML: "<p>Sig</p>" });
  assert.equal(c.signatureHtml, "<p>Sig</p>");
  // blank counts as unset
  assert.throws(() => loadServerConfig({ ...base, ...creds, SIGNATURE_HTML: "   " }), /SIGNATURE_PATH/);
  // takes precedence over a path that does not exist
  assert.equal(loadServerConfig({ ...base, ...creds, SIGNATURE_HTML: "<p>x</p>", SIGNATURE_PATH: "/nope/missing.html" }).signatureHtml, "<p>x</p>");
  assert.throws(
    () => loadServerConfig({ ...base, ...creds, SIGNATURE_HTML: "a".repeat(64 * 1024 + 1) }),
    (e) => /SIGNATURE_HTML/.test(e.message) && !e.message.includes("aaaa"),
  );
  assert.equal(loadServerConfig({ ...base, SIGNATURE_HTML: "a".repeat(64 * 1024) }).signatureHtml.length, 64 * 1024);
});

const PLACEHOLDER = "PLACEHOLDER-replace-with-gcloud-secrets-versions-add";

test("placeholder secret values fail validation by variable name and are never echoed", () => {
  for (const key of ["DATABASE_URL", "SESSION_SECRET", "SIGNATURE_HTML", "GMAIL_APP_PASSWORD"]) {
    let msg = "";
    try {
      loadServerConfig({ ...base, [key]: PLACEHOLDER });
    } catch (err) {
      msg = err.message;
    }
    assert.match(msg, new RegExp(`${key}.*placeholder`, "i"), key);
    assert.ok(!msg.includes(PLACEHOLDER), `${key}: value is not echoed`);
  }
});

test("loadAdminSeedConfig rejects a placeholder ADMIN_PASSWORD without echoing it", () => {
  let msg = "";
  try {
    loadAdminSeedConfig({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: PLACEHOLDER });
  } catch (err) {
    msg = err.message;
  }
  assert.match(msg, /ADMIN_PASSWORD.*placeholder/i);
  assert.ok(!msg.includes(PLACEHOLDER));
});
