import { readFileSync } from "node:fs";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { parseCsv, CsvFileError } from "../../import/parseCsv.js";
import { renderInitialPreview } from "../../domain/render.js";
import { inTx, serializeBatch, serializeContact } from "../../domain/contacts.js";

const MAX_UPLOAD_BYTES = 1024 * 1024;
const uuid = z.uuid();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 1024 },
  fileFilter(_req, file, cb) {
    if (!/\.csv$/i.test(file.originalname)) return cb(new HttpError(400, "Only .csv files are accepted"));
    cb(null, true);
  },
}).single("file");

function receiveUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "File too large (limit 1MB)"));
      return next(new HttpError(400, "Invalid upload"));
    }
    next(new HttpError(400, "Invalid upload"));
  });
}

const bodySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .max(120)
    .regex(/^[^\p{Cc}]*$/u, "name must not contain control characters")
    .optional(),
});

// multer decodes filenames as latin1; recover UTF-8 then strip anything unsafe for display.
export function defaultBatchName(originalname) {
  let n = originalname;
  try {
    n = Buffer.from(originalname, "latin1").toString("utf8");
  } catch {}
  n = n
    .replace(/\.csv$/i, "")
    .replace(/[\p{Cc}<>"'`\\/]/gu, "")
    .trim()
    .slice(0, 120)
    .trim();
  return n || "Imported batch";
}

function loadSignature(config) {
  if (!config?.signaturePath) return "";
  try {
    return readFileSync(config.signaturePath, "utf8");
  } catch {
    return "";
  }
}

export function batchesRouter({ pool, config }) {
  const router = Router();
  const signatureHtml = loadSignature(config);
  const withPreview = (row) => ({ ...serializeContact(row), preview: renderInitialPreview({ subject: row.subject, mailText: row.mail_text }, signatureHtml) });

  router.post("/", receiveUpload, async (req, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, "A CSV file is required in the 'file' field");
      const parsedBody = bodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) throw new HttpError(400, parsedBody.error.issues[0]?.message ?? "Invalid fields");
      const name = parsedBody.data.name || defaultBatchName(req.file.originalname);
      const filename = defaultBatchName(req.file.originalname) + ".csv";

      const sup = await pool.query("SELECT email FROM suppressions");
      let parsed;
      try {
        parsed = parseCsv(req.file.buffer, { suppressed: new Set(sup.rows.map((r) => r.email)) });
      } catch (err) {
        if (err instanceof CsvFileError) throw new HttpError(400, err.message);
        throw err;
      }
      const { rows, errors } = parsed;
      if (rows.length === 0) {
        return res.status(422).json({ error: "No valid rows to import", errors });
      }

      const result = await inTx(pool, async (db) => {
        const b = await db.query(
          "INSERT INTO batches(name, original_filename, created_by) VALUES ($1, $2, $3) RETURNING *",
          [name, filename, req.session.userId],
        );
        const batch = b.rows[0];
        const col = (k) => rows.map((r) => r[k]);
        const inserted = await db.query(
          `INSERT INTO contacts(batch_id, company, role, person, email, subject, mail_text, followup_text, created_at)
           SELECT $1::uuid, u.company, u.role, u.person, u.email, u.subject, u.mail_text, u.followup_text, clock_timestamp() FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) WITH ORDINALITY AS u(company, role, person, email, subject, mail_text, followup_text, ord)
           ORDER BY u.ord
           RETURNING *`,
          [batch.id, col("company"), col("role"), col("person"), col("email"), col("subject"), col("mailText"), col("followupText")],
        );
        await db.query(
          "INSERT INTO events(contact_id, type, meta) SELECT id, 'imported', jsonb_build_object('batchId', $1::text) FROM unnest($2::uuid[]) AS id",
          [batch.id, inserted.rows.map((r) => r.id)],
        );
        await db.query("INSERT INTO events(type, meta) VALUES ('batch_created', $1)", [
          JSON.stringify({ batchId: batch.id, imported: inserted.rowCount, rejected: errors.length }),
        ]);
        return { batch, contacts: inserted.rows };
      });
      res.status(201).json({
        batch: serializeBatch(result.batch),
        contacts: result.contacts.map(withPreview),
        errors,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.*, (SELECT count(*)::int FROM contacts c WHERE c.batch_id = b.id) AS contact_count
           FROM batches b ORDER BY b.created_at DESC, b.id`,
      );
      const counts = await pool.query("SELECT batch_id, status, count(*)::int AS n FROM contacts GROUP BY batch_id, status");
      const byBatch = new Map();
      for (const r of counts.rows) byBatch.set(r.batch_id, { ...(byBatch.get(r.batch_id) ?? {}), [r.status]: r.n });
      res.json({
        batches: rows.map((r) => ({ ...serializeBatch(r), contactCount: r.contact_count, statusCounts: byBatch.get(r.id) ?? {} })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) throw new HttpError(400, "Invalid batch id");
      const b = await pool.query("SELECT * FROM batches WHERE id = $1", [id.data]);
      if (!b.rowCount) throw new HttpError(404, "Batch not found");
      const c = await pool.query("SELECT * FROM contacts WHERE batch_id = $1 ORDER BY created_at, id", [id.data]);
      res.json({ batch: serializeBatch(b.rows[0]), contacts: c.rows.map(withPreview) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
