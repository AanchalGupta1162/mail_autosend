import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { describeAttachments } from "../../domain/resumes.js";
import { CONTACT_STATUSES, markReplied, optOut, serializeContact } from "../../domain/contacts.js";

const uuid = z.uuid();

const listQuery = z.strictObject({
  status: z.enum(CONTACT_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  batchId: uuid.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function contactsRouter({ pool, config = {} }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw new HttpError(400, "Invalid query parameters");
      const { status, q, batchId, page, pageSize } = parsed.data;
      const where = [];
      const params = [];
      const add = (v) => (params.push(v), `$${params.length}`);
      if (status) where.push(`status = ${add(status)}`);
      if (batchId) where.push(`batch_id = ${add(batchId)}`);
      if (q) {
        const p = add(`%${escapeLike(q)}%`);
        where.push(`(company ILIKE ${p} OR role ILIKE ${p} OR person ILIKE ${p} OR email ILIKE ${p} OR subject ILIKE ${p})`);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = await pool.query(`SELECT count(*)::int AS n FROM contacts ${clause}`, params);
      const limit = add(pageSize);
      const offset = add((page - 1) * pageSize);
      const { rows } = await pool.query(
        `SELECT * FROM contacts ${clause} ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      // Live (non-cancelled) messages per listed contact, so the UI can cancel/reschedule by id.
      const msgs = await pool.query(
        `SELECT id, contact_id, kind, state, scheduled_for, sent_at FROM messages
          WHERE contact_id = ANY($1::uuid[]) AND state <> 'cancelled' ORDER BY scheduled_for, id`,
        [rows.map((r) => r.id)],
      );
      const byContact = new Map();
      for (const m of msgs.rows) {
        const list = byContact.get(m.contact_id) ?? [];
        list.push({ id: m.id, kind: m.kind, state: m.state, scheduledFor: m.scheduled_for, sentAt: m.sent_at });
        byContact.set(m.contact_id, list);
      }
      const attachments = await describeAttachments(pool, rows.map((r) => r.id), config);
      res.json({
        contacts: rows.map((r) => ({ ...serializeContact(r), attachment: attachments.get(r.id) ?? null, messages: byContact.get(r.id) ?? [] })),
        total: total.rows[0].n,
        page,
        pageSize,
      });
    } catch (err) {
      next(err);
    }
  });

  const idParam = (req) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "Invalid contact id");
    return id.data;
  };

  router.post("/:id/mark-replied", async (req, res, next) => {
    try {
      res.json({ contact: await markReplied(pool, idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/opt-out", async (req, res, next) => {
    try {
      res.json({ contact: await optOut(pool, idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
