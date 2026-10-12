import { promisify } from "node:util";
import { Router } from "express";
import { z } from "zod";
import { hashPassword, verifyPassword, dummyHash } from "./password.js";
import { newCsrfToken } from "./middleware.js";
import { HttpError } from "../server/errors.js";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
const GENERIC_LOGIN_ERROR = "Invalid username or password";

const loginBody = z.strictObject({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});
const changeBody = z
  .strictObject({
    currentPassword: z.string().min(1).max(1000),
    newPassword: z.string().min(10, "New password must be at least 10 characters").max(1000),
  })
  .refine((b) => b.currentPassword !== b.newPassword, { message: "New password must differ from the current one" });

// One atomic statement: increments (restarting at 1 if an old lock has expired)
// and locks the account on reaching the limit.
async function recordFailure(pool, userId) {
  await pool.query(
    `UPDATE users u SET failed_attempts = s.n,
            locked_until = CASE WHEN s.n >= $2 THEN now() + make_interval(mins => $3) ELSE NULL END
       FROM (SELECT id, CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                             THEN 1 ELSE failed_attempts + 1 END AS n
               FROM users WHERE id = $1) s
      WHERE u.id = s.id`,
    [userId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
  );
}

export function authRouter({ pool }) {
  const router = Router();

  // Rotates the session id (anti fixation) and issues a fresh CSRF token.
  async function startSession(req, userId) {
    await promisify(req.session.regenerate.bind(req.session))();
    req.session.userId = userId;
    req.session.csrf = newCsrfToken();
    await promisify(req.session.save.bind(req.session))();
    return req.session.csrf;
  }

  router.get("/csrf", async (req, res, next) => {
    try {
      if (!req.session.csrf) req.session.csrf = newCsrfToken();
      res.json({ csrfToken: req.session.csrf });
    } catch (err) {
      next(err);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const parsed = loginBody.safeParse(req.body);
      const username = parsed.success ? parsed.data.username : "";
      const password = parsed.success ? parsed.data.password : "";
      const { rows } = await pool.query(
        "SELECT id, username, password_hash, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users WHERE lower(username) = lower($1)",
        [username],
      );
      const user = rows[0];
      // Same scrypt work whether or not the user exists / input was valid.
      const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash());
      if (!parsed.success || !user || !ok || user.locked) {
        if (user && !user.locked && !ok) await recordFailure(pool, user.id);
        throw new HttpError(401, GENERIC_LOGIN_ERROR);
      }
      await pool.query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
      const csrfToken = await startSession(req, user.id);
      res.json({ user: { id: user.id, username: user.username }, csrfToken });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      await promisify(req.session.destroy.bind(req.session))();
      res.clearCookie("sid", { path: "/" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const { rows } = await pool.query("SELECT id, username FROM users WHERE id = $1", [req.session.userId]);
      if (!rows[0]) throw new HttpError(401, "Authentication required");
      res.json({ user: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  router.post("/change-password", async (req, res, next) => {
    try {
      const parsed = changeBody.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request");
      const { currentPassword, newPassword } = parsed.data;
      const { rows } = await pool.query(
        "SELECT id, password_hash, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users WHERE id = $1",
        [req.session.userId],
      );
      const user = rows[0];
      if (!user) throw new HttpError(401, "Authentication required");
      const ok = await verifyPassword(currentPassword, user.password_hash);
      if (!ok || user.locked) {
        if (!user.locked && !ok) await recordFailure(pool, user.id);
        throw new HttpError(400, "Current password is incorrect");
      }
      const hash = await hashPassword(newPassword);
      await pool.query(
        "UPDATE users SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1",
        [user.id, hash],
      );
      const csrfToken = await startSession(req, user.id);
      // Invalidate every other session of this user.
      await pool.query(`DELETE FROM "session" WHERE sess->>'userId' = $1 AND sid <> $2`, [user.id, req.sessionID]);
      res.json({ ok: true, csrfToken });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
