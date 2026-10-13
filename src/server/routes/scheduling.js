import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { cancelMessage, resolveMessage, RESOLVE_ACTIONS, scheduleBulk, scheduleContact, syncFollowup, validateSendAt, planStagger, MAX_DAYS_AHEAD } from "../../domain/schedule.js";
import { setContactResume } from "../../domain/resumes.js";
import { serializeContact } from "../../domain/contacts.js";
import { getTemplate, putTemplate, templateSchema } from "../../domain/template.js";

// Normalised to lower case so the same id in two spellings is recognised as a duplicate.
const uuid = z.uuid().transform((v) => v.toLowerCase());
const MAX_STAGGER_MINUTES = 24 * 60;

const bulkBody = z.strictObject({
  contactIds: z.array(uuid).min(1).max(500),
  sendAt: z.string(),
  staggerMinutes: z.number().int().min(0).max(MAX_STAGGER_MINUTES).optional(),
  resumeId: uuid.nullable().optional(),
});
const resolveBody = z.strictObject({ action: z.enum(RESOLVE_ACTIONS) });
const oneBody = z.strictObject({ sendAt: z.string(), resumeId: uuid.nullable().optional() });
const resumeBody = z.strictObject({ resumeId: uuid.nullable() });
const followupBody = z.strictObject({
  enabled: z.boolean(),
  delayDays: z.number().int().min(1).max(60).optional(),
});

const param = (req, label) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) throw new HttpError(400, `Invalid ${label} id`);
  return id.data;
};
const body = (schema, req) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ? `Invalid request: ${r.error.issues[0].path.join(".") || "body"}` : "Invalid request");
  return r.data;
};

// Mounted at /api. Handles only its own paths; everything else falls through.
export function schedulingRouter({ pool, config = {}, now = () => new Date() }) {
  const router = Router();
  // Real mode with no legacy RESUME_PATH: a mail must never go out because nobody picked a resume.
  const requireResume = !config.dryRun && !config.resumePath;
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  router.post("/batches/:id/schedule", wrap(async (req, res) => {
    const batchId = param(req, "batch");
    const b = body(bulkBody, req);
    if (new Set(b.contactIds).size !== b.contactIds.length) throw new HttpError(400, "contactIds must be unique");
    const sendAt = validateSendAt(b.sendAt, now());
    const stagger = b.staggerMinutes ?? 0;
    const last = planStagger(sendAt, b.contactIds.length, stagger).at(-1);
    if (last.getTime() > now().getTime() + MAX_DAYS_AHEAD * 86_400_000) {
      throw new HttpError(400, `Staggered times must all be within ${MAX_DAYS_AHEAD} days`);
    }
    const messages = await scheduleBulk(pool, { batchId, contactIds: b.contactIds, sendAt, staggerMinutes: stagger, resumeId: b.resumeId, requireResume });
    res.status(201).json({ messages });
  }));

  router.put("/contacts/:id/schedule", wrap(async (req, res) => {
    const id = param(req, "contact");
    const b = body(oneBody, req);
    const sendAt = validateSendAt(b.sendAt, now());
    res.json({ message: await scheduleContact(pool, id, sendAt, { resumeId: b.resumeId, requireResume }) });
  }));

  router.put("/contacts/:id/resume", wrap(async (req, res) => {
    const id = param(req, "contact");
    const b = body(resumeBody, req);
    res.json({ contact: serializeContact(await setContactResume(pool, id, b.resumeId, { requireResume })) });
  }));

  router.put("/contacts/:id/followup", wrap(async (req, res) => {
    const id = param(req, "contact");
    res.json(await syncFollowup(pool, id, body(followupBody, req)));
  }));

  router.delete("/messages/:id", wrap(async (req, res) => {
    res.json(await cancelMessage(pool, param(req, "message")));
  }));

  router.post("/messages/:id/resolve", wrap(async (req, res) => {
    const id = param(req, "message");
    res.json(await resolveMessage(pool, id, body(resolveBody, req).action, now()));
  }));

  router.get("/template/followup", wrap(async (_req, res) => {
    res.json({ template: await getTemplate(pool) });
  }));

  router.put("/template/followup", wrap(async (req, res) => {
    res.json({ template: await putTemplate(pool, body(templateSchema, req)) });
  }));

  return router;
}
