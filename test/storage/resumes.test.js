import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalStorage, createGcsStorage, createResumeStorage, ResumeStorageError } from "../../src/storage/resumes.js";
import { FakeGcsClient } from "../helpers/fakeGcs.js";

const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);
const sha = (b) => createHash("sha256").update(b).digest("hex");

// The same contract for every adapter.
function contract(name, make) {
  describe(`${name} adapter`, () => {
    let ctx;
    before(async () => (ctx = await make()));
    after(async () => ctx.cleanup?.());

    test("put returns key, generation, size and sha256; get(key, generation) returns the exact bytes", async () => {
      const buf = pdf("one");
      const out = await ctx.storage.put(buf, { fileName: "My Resume.pdf" });
      assert.equal(typeof out.key, "string");
      assert.ok(out.key.length > 0 && !out.key.includes("..") && !out.key.includes("/"));
      assert.equal(typeof out.generation, "string");
      assert.equal(out.size, buf.length);
      assert.equal(out.sha256, sha(buf));
      assert.deepEqual(await ctx.storage.get(out.key, out.generation), buf);
    });

    test("two uploads of the same file name get distinct keys", async () => {
      const a = await ctx.storage.put(pdf("a"), { fileName: "r.pdf" });
      const b = await ctx.storage.put(pdf("b"), { fileName: "r.pdf" });
      assert.notEqual(a.key, b.key);
    });

    test("get of a missing key fails with a not_found ResumeStorageError", async () => {
      const out = await ctx.storage.put(pdf("x"), { fileName: "r.pdf" });
      await ctx.storage.delete(out.key);
      await assert.rejects(ctx.storage.get(out.key, out.generation), (e) => e instanceof ResumeStorageError && e.reason === "not_found");
    });

    test("get with a generation that is no longer current fails (pinned bytes only)", async () => {
      const out = await ctx.storage.put(pdf("y"), { fileName: "r.pdf" });
      await assert.rejects(ctx.storage.get(out.key, "999999999999"), (e) => e instanceof ResumeStorageError && e.reason === "not_found");
    });

    test("delete is idempotent", async () => {
      const out = await ctx.storage.put(pdf("z"), { fileName: "r.pdf" });
      await ctx.storage.delete(out.key);
      await ctx.storage.delete(out.key);
    });

    test("a hostile key is refused without touching anything", async () => {
      for (const k of ["../etc/passwd", "a/b", "", "..", "x\0y"]) {
        await assert.rejects(ctx.storage.get(k, "1"), (e) => e instanceof ResumeStorageError && e.reason === "invalid");
        await assert.rejects(ctx.storage.delete(k), (e) => e instanceof ResumeStorageError && e.reason === "invalid");
      }
    });
  });
}

contract("local", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "resumes-"));
  return { storage: createLocalStorage({ dir: path.join(dir, "nested") }), cleanup: () => rm(dir, { recursive: true, force: true }), dir };
});

contract("gcs (in-process fake client)", async () => ({ storage: createGcsStorage({ bucket: "b", client: new FakeGcsClient() }) }));

test("local: files are written inside the directory only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "resumes-"));
  try {
    const s = createLocalStorage({ dir });
    const out = await s.put(pdf("q"), { fileName: "../../evil.pdf" });
    assert.deepEqual(await readdir(dir), [out.key]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gcs: a replaced object keeps serving the old generation to a pinned read", async () => {
  const client = new FakeGcsClient();
  const s = createGcsStorage({ bucket: "b", client });
  const first = await s.put(pdf("v1"), { fileName: "r.pdf" });
  // Someone overwrites the same object out of band: new generation, new bytes.
  client.overwrite("b", first.key, pdf("v2"));
  assert.deepEqual(await s.get(first.key, first.generation), pdf("v1"));
  assert.equal(client.reads.at(-1).generation, first.generation, "the read is pinned to the stored generation");
});

test("gcs: put never overwrites an existing object (ifGenerationMatch 0)", async () => {
  const client = new FakeGcsClient();
  const s = createGcsStorage({ bucket: "b", client });
  const out = await s.put(pdf("v1"), { fileName: "r.pdf" });
  assert.equal(client.saves.at(-1).preconditionOpts.ifGenerationMatch, 0);
  assert.ok(out.key);
});

test("gcs: permission and network failures map to safe, non-leaky errors", async () => {
  const client = new FakeGcsClient();
  const s = createGcsStorage({ bucket: "secret-bucket-name", client });
  const out = await s.put(pdf("v1"), { fileName: "r.pdf" });
  client.failNext({ code: 403, message: "caller does not have storage.objects.get access to secret-bucket-name/obj" });
  await assert.rejects(s.get(out.key, out.generation), (e) => e.reason === "permission" && !/secret-bucket-name|obj/.test(e.message));
  client.failNext({ code: "ECONNRESET", message: "socket hang up" });
  await assert.rejects(s.get(out.key, out.generation), (e) => e.reason === "unavailable");
  client.failNext({ code: 404, message: "No such object" });
  await assert.rejects(s.get(out.key, out.generation), (e) => e.reason === "not_found");
});

test("createResumeStorage picks the adapter from config", () => {
  assert.equal(createResumeStorage({ resumeStorage: "local", resumeLocalDir: "/tmp/x" }).kind, "local");
  assert.equal(createResumeStorage({ resumeStorage: "gcs", resumeBucket: "b" }, { client: new FakeGcsClient() }).kind, "gcs");
  assert.throws(() => createResumeStorage({ resumeStorage: "gcs" }, { client: new FakeGcsClient() }), /RESUME_BUCKET/);
});
