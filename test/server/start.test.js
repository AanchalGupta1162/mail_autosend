import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/db.js";
import { loadServerConfig } from "../../src/server/env.js";
import { startServer, createWorkers } from "../../src/server/start.js";

const silent = { error() {}, warn() {}, info() {} };
const INTERNAL = { INTERNAL_AUDIENCE: "https://b.example.run.app", INTERNAL_INVOKER_SA: "inv@p.iam.gserviceaccount.com" };
const cfg = (extra = {}) =>
  loadServerConfig({ DATABASE_URL: process.env.DATABASE_URL, SESSION_SECRET: "s".repeat(40), PORT: "3000", ...extra });
const fakePoller = (tag) => (opts) => ({ tag, opts, start() { this.started = true; }, async stop() { this.stopped = true; } });

let db;
before(async () => {
  db = await createTestDb();
});
after(async () => db?.close());

test("createWorkers: polling mode builds the send poller (and the sweep poller in real mode with sweep enabled)", () => {
  const dev = createWorkers({ config: cfg({ NODE_ENV: "development" }), pool: db.pool, mailer: {}, createPoller: (o) => fakePoller("p")(o), logger: silent });
  assert.ok(dev.poller);
  assert.equal(dev.sweepPoller, null, "dry-run has no inbox");
  const real = createWorkers({
    config: { ...cfg({ NODE_ENV: "development" }), dryRun: false, replySweepEnabled: true },
    pool: db.pool, mailer: {}, createPoller: (o) => fakePoller("p")(o), logger: silent,
  });
  assert.ok(real.poller && real.sweepPoller);
});

test("createWorkers: scheduled mode starts no pollers at all, even in real mode", () => {
  const w = createWorkers({
    config: { ...cfg({ WORKER_MODE: "scheduled", ...INTERNAL }), dryRun: false, replySweepEnabled: true },
    pool: db.pool, mailer: {}, createPoller: () => assert.fail("must not create a poller"), logger: silent,
  });
  assert.deepEqual(w, { poller: null, sweepPoller: null });
});

test("createWorkers: NODE_ENV=test never polls", () => {
  const w = createWorkers({ config: cfg({ NODE_ENV: "test" }), pool: db.pool, mailer: {}, createPoller: () => assert.fail("no"), logger: silent });
  assert.deepEqual(w, { poller: null, sweepPoller: null });
});

test("startServer: migrates on start by default, skips with MIGRATE_ON_START=false; serves HTTP either way", async () => {
  for (const [flag, expected] of [[undefined, 1], ["true", 1], ["false", 0]]) {
    let migrations = 0;
    const s = await startServer({
      config: cfg({ WORKER_MODE: "scheduled", NODE_ENV: "test", PORT: "1", ...INTERNAL, ...(flag ? { MIGRATE_ON_START: flag } : {}) }),
      pool: db.pool,
      migrate: async () => { migrations++; },
      listenPort: 0,
      logger: silent,
    });
    try {
      assert.equal(migrations, expected, `MIGRATE_ON_START=${flag}`);
      const r = await fetch(`http://127.0.0.1:${s.server.address().port}/healthz`);
      assert.equal(r.status, 200);
      assert.deepEqual(s.workers, { poller: null, sweepPoller: null });
    } finally {
      await s.close();
    }
  }
});

test("startServer: close() aborts the shutdown signal and stops started workers", async () => {
  const pollers = [];
  const s = await startServer({
    config: { ...cfg({ NODE_ENV: "development" }), dryRun: false, replySweepEnabled: true },
    pool: db.pool,
    migrate: async () => {},
    listenPort: 0,
    logger: silent,
    createPoller: (o) => { const p = fakePoller("p")(o); pollers.push(p); return p; },
  });
  assert.equal(pollers.length, 2);
  assert.ok(pollers.every((p) => p.started));
  assert.equal(s.shutdownSignal.aborted, false);
  await s.close();
  assert.equal(s.shutdownSignal.aborted, true);
  assert.ok(pollers.every((p) => p.stopped));
});
