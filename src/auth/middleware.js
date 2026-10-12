import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../server/errors.js";

// Routes reachable without a session. Everything else under /api is denied by default.
const PUBLIC = new Set(["/auth/csrf", "/auth/login"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function newCsrfToken() {
  return randomBytes(32).toString("base64url");
}

// Hash both sides so the comparison is constant-time and length-independent.
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// Mounted on /api before any router: 401 unless the session carries a user.
export function requireAuth(req, _res, next) {
  if (PUBLIC.has(req.path)) return next();
  if (!req.session?.userId) return next(new HttpError(401, "Authentication required"));
  next();
}

// Every POST/PUT/PATCH/DELETE (login included) must carry the session's CSRF token.
export function requireCsrf(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = req.session?.csrf;
  const given = req.get("x-csrf-token");
  if (!expected || typeof given !== "string" || !safeEqual(given, expected)) {
    return next(new HttpError(403, "Invalid CSRF token"));
  }
  next();
}
