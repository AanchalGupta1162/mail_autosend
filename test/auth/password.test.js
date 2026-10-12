import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hashPassword, verifyPassword } from "../../src/auth/password.js";

test("hash is self-describing scrypt, not plaintext, and salted", async () => {
  const a = await hashPassword("hunter2-hunter2");
  const b = await hashPassword("hunter2-hunter2");
  assert.ok(!a.includes("hunter2"));
  const parts = a.split("$");
  assert.deepEqual(parts.slice(0, 4), ["scrypt", "32768", "8", "1"]);
  assert.equal(Buffer.from(parts[4], "base64").length, 16);
  assert.equal(Buffer.from(parts[5], "base64").length, 64);
  assert.notEqual(a, b);
});

test("verify accepts right password, rejects wrong, never throws on garbage", async () => {
  const h = await hashPassword("right-password-1");
  assert.equal(await verifyPassword("right-password-1", h), true);
  assert.equal(await verifyPassword("wrong-password-1", h), false);
  for (const bad of ["", "plaintext", "scrypt$1$2$3", "scrypt$32768$8$1$AAAA$AAAA", null, undefined, "bcrypt$x$y$z$a$b"]) {
    assert.equal(await verifyPassword("right-password-1", bad), false);
  }
});

test("verify uses crypto.timingSafeEqual", async () => {
  const src = await readFile(new URL("../../src/auth/password.js", import.meta.url), "utf8");
  assert.match(src, /timingSafeEqual/);
});
