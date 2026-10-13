import { Router } from "express";
import { HttpError } from "../errors.js";
import { getSendWindow, putSendWindow, sendWindowSchema } from "../../domain/sendWindow.js";

// Mounted at /api, behind requireAuth + requireCsrf.
export function settingsRouter({ pool, config }) {
  const router = Router();
  const enforced = config.sendWindowEnforced === true;
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  // `enforced` tells the UI whether the window actually gates sending (production) or is informational (local dev).
  router.get("/settings/send-window", wrap(async (_req, res) => {
    res.json({ enforced, window: await getSendWindow(pool) });
  }));

  router.put("/settings/send-window", wrap(async (req, res) => {
    const parsed = sendWindowSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, `Invalid send window: ${parsed.error.issues[0]?.message ?? "check the values"}`);
    res.json({ enforced, window: await putSendWindow(pool, parsed.data) });
  }));

  return router;
}
