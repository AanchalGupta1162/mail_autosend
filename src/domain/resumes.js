import { HttpError } from "../server/errors.js";
import { inTx } from "./contacts.js";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const PENDING_STATES = ["scheduled", "sending", "needs_review"];

export function serializeResume(r, usage) {
  return {
    id: r.id,
    displayName: r.display_name,
    fileName: r.file_name,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    isDefault: r.is_default,
    createdAt: r.created_at,
    usage: usage ?? {
      pendingMessages: r.pending ?? 0,
      batches: r.batch_count ?? 0,
      contacts: r.contact_count ?? 0,
    },
  };
}

// True when the buffer starts with the PDF header. This, not the extension or the multipart
// content type, decides whether an upload is a PDF.
export const isPdf = (buf) => buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";

// The name the recipient sees on the attachment: a plain, header-safe ".pdf" name.
export function sanitizeFileName(original) {
  let n = String(original ?? "");
  try {
    n = Buffer.from(n, "latin1").toString("utf8"); // multer decodes names as latin1
  } catch {}
  n = n.split(/[\\/]/).pop();
  n = n
    .replace(/\.pdf$/i, "")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 80)
    .trim();
  return `${n || "resume"}.pdf`;
}

const uniqueViolation = (err, index) => err?.code === "23505" && String(err.constraint ?? "").includes(index);

export async function listResumes(pool) {
  const { rows } = await pool.query(
    `SELECT r.*,
            (SELECT count(*)::int FROM messages m WHERE m.resume_id = r.id AND m.state = ANY($1::text[])) AS pending,
            (SELECT count(*)::int FROM batches b WHERE b.resume_id = r.id) AS batch_count,
            (SELECT count(*)::int FROM contacts c WHERE c.resume_id = r.id) AS contact_count
       FROM resumes r WHERE r.deleted_at IS NULL
      ORDER BY r.is_default DESC, lower(r.display_name), r.id`,
    [PENDING_STATES],
  );
  return rows.map((r) => serializeResume(r));
}

const DUP = () => new HttpError(409, "A resume with this name already exists");

export async function createResume(pool, storage, { displayName, fileName, buffer }) {
  const dup = await pool.query("SELECT 1 FROM resumes WHERE lower(display_name) = lower($1) AND deleted_at IS NULL", [displayName]);
  if (dup.rowCount) throw DUP();
  const stored = await storage.put(buffer, { fileName });
  const insert = (makeDefault) =>
    pool.query(
      `INSERT INTO resumes(display_name, file_name, storage_key, generation, size_bytes, sha256, is_default)
       VALUES ($1,$2,$3,$4,$5,$6, $7 AND NOT EXISTS (SELECT 1 FROM resumes WHERE is_default AND deleted_at IS NULL)) RETURNING *`,
      [displayName, fileName, stored.key, stored.generation, stored.size, stored.sha256, makeDefault],
    );
  try {
    let res;
    try {
      res = await insert(true); // the first live resume becomes the default
    } catch (err) {
      if (!uniqueViolation(err, "resumes_one_default_idx")) throw err;
      res = await insert(false); // lost a race for the default slot
    }
    await pool.query("INSERT INTO events(type, meta) VALUES ('resume_uploaded', $1)", [JSON.stringify({ resumeId: res.rows[0].id })]);
    return serializeResume(res.rows[0]);
  } catch (err) {
    await storage.delete(stored.key).catch(() => {}); // do not leave an orphan object behind
    throw uniqueViolation(err, "resumes_live_name_idx") ? DUP() : err;
  }
}

export async function updateResume(pool, id, { displayName, isDefault }) {
  try {
    return await inTx(pool, async (db) => {
      const cur = await db.query("SELECT * FROM resumes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
      if (!cur.rowCount) throw new HttpError(404, "Resume not found");
      if (isDefault === true) await db.query("UPDATE resumes SET is_default = false WHERE is_default AND id <> $1", [id]);
      const { rows } = await db.query(
        "UPDATE resumes SET display_name = COALESCE($2, display_name), is_default = COALESCE($3, is_default) WHERE id = $1 RETURNING *",
        [id, displayName ?? null, isDefault ?? null],
      );
      await db.query("INSERT INTO events(type, meta) VALUES ('resume_updated', $1)", [JSON.stringify({ resumeId: id })]);
      return serializeResume(rows[0]);
    });
  } catch (err) {
    throw uniqueViolation(err, "resumes_live_name_idx") ? DUP() : err;
  }
}

// Soft delete. Refused while a message that has not been sent yet is going to attach it. The storage
// object is removed only if no message at all references it (a follow-up created later copies the
// initial's snapshot and must still find its bytes).
export async function deleteResume(pool, storage, id) {
  const { key, removable } = await inTx(pool, async (db) => {
    const cur = await db.query("SELECT * FROM resumes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [id]);
    if (!cur.rowCount) throw new HttpError(404, "Resume not found");
    const pending = await db.query("SELECT count(*)::int AS n FROM messages WHERE resume_id = $1 AND state = ANY($2::text[])", [id, PENDING_STATES]);
    const n = pending.rows[0].n;
    if (n > 0) {
      throw new HttpError(409, `This resume is attached to ${n} message${n === 1 ? "" : "s"} that ${n === 1 ? "has" : "have"} not been sent yet. Cancel or send ${n === 1 ? "it" : "them"} first.`, { pendingMessages: n });
    }
    await db.query("UPDATE resumes SET deleted_at = now(), is_default = false WHERE id = $1", [id]);
    await db.query("UPDATE batches SET resume_id = NULL WHERE resume_id = $1", [id]);
    await db.query("UPDATE contacts SET resume_id = NULL WHERE resume_id = $1", [id]);
    const refs = await db.query("SELECT count(*)::int AS n FROM messages WHERE resume_id = $1", [id]);
    await db.query("INSERT INTO events(type, meta) VALUES ('resume_deleted', $1)", [JSON.stringify({ resumeId: id })]);
    return { key: cur.rows[0].storage_key, removable: refs.rows[0].n === 0 };
  });
  if (removable) await storage.delete(key).catch(() => {});
}
