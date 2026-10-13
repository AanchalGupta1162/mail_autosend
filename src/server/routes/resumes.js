import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../errors.js";
import { createResume, deleteResume, isPdf, listResumes, MAX_RESUME_BYTES, sanitizeFileName, updateResume } from "../../domain/resumes.js";

const uuid = z.uuid().transform((v) => v.toLowerCase());

// 1-80 characters, no control or bidi-override characters (checked before trimming).
const displayName = z
  .string()
  .regex(/^[^\p{Cc}‪-‮⁦-⁩]*$/u, "displayName must not contain control characters")
  .trim()
  .min(1, "displayName is required")
  .max(80, "displayName must be at most 80 characters");

const uploadFields = z.strictObject({ displayName });
const updateBody = z
  .strictObject({ displayName: displayName.optional(), isDefault: z.boolean().optional() })
  .refine((b) => b.displayName !== undefined || b.isDefault !== undefined, "Nothing to update");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1, fields: 3, parts: 5, fieldSize: 1024 },
}).single("file");

function receiveUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "File too large (limit 5 MB)"));
    next(new HttpError(400, "Invalid upload"));
  });
}

const firstIssue = (r) => r.error.issues[0]?.message ?? "Invalid request";

export function resumesRouter({ pool, storage }) {
  const router = Router();
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };
  const idParam = (req) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw new HttpError(400, "Invalid resume id");
    return id.data;
  };

  router.get("/", wrap(async (_req, res) => {
    res.json({ resumes: await listResumes(pool) });
  }));

  router.post("/", receiveUpload, wrap(async (req, res) => {
    const fields = uploadFields.safeParse(req.body ?? {});
    if (!fields.success) throw new HttpError(400, firstIssue(fields));
    if (!req.file) throw new HttpError(400, "A PDF file is required in the 'file' field");
    if (req.file.size === 0) throw new HttpError(400, "The file is empty");
    if (!isPdf(req.file.buffer)) throw new HttpError(400, "Only PDF files are accepted (the file does not look like a PDF)");
    const resume = await createResume(pool, storage, {
      displayName: fields.data.displayName,
      fileName: sanitizeFileName(req.file.originalname),
      buffer: req.file.buffer,
    });
    res.status(201).json({ resume });
  }));

  router.put("/:id", wrap(async (req, res) => {
    const id = idParam(req);
    const body = updateBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, firstIssue(body));
    res.json({ resume: await updateResume(pool, id, body.data) });
  }));

  router.delete("/:id", wrap(async (req, res) => {
    await deleteResume(pool, storage, idParam(req));
    res.json({ ok: true });
  }));

  return router;
}
