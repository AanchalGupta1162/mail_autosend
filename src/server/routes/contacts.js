import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../errors.js";
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

export function contactsRouter({ pool }) {
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
      res.json({ contacts: rows.map(serializeContact), total: total.rows[0].n, page, pageSize });
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
