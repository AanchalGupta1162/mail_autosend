import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;
const MAXMEM = 128 * N * R * 2; // scrypt needs 128*N*r bytes; default cap is too tight

function derive(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// Format: scrypt$N$r$p$<salt b64>$<key b64>
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

// Returns false (never throws) for wrong passwords or malformed stored values.
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  // Only our own parameters are accepted: stops a tampered row from forcing huge work.
  if (n !== N || r !== R || p !== P) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length !== SALT_LEN || expected.length !== KEYLEN) return false;
  const actual = await derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}

// Verified for unknown usernames so that login does equal work either way.
let dummy;
export function dummyHash() {
  dummy ??= hashPassword("dummy-password-for-equal-work");
  return dummy;
}
