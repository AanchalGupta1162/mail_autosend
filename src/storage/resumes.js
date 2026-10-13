import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Resume object storage. Adapters share one contract:
//   put(buffer, {fileName}) -> {key, generation, size, sha256}   (never overwrites; a fresh key per upload)
//   get(key, generation)    -> Buffer                            (exactly that generation, or ResumeStorageError)
//   delete(key)             -> void                              (idempotent)
// Errors carry a coarse `reason` (not_found | permission | unavailable | invalid) and a generic message:
// they never include bucket names, keys, paths or credentials, so they are safe to log and to store.

export class ResumeStorageError extends Error {
  constructor(reason) {
    super(
      {
        not_found: "resume object not found",
        permission: "resume storage refused access",
        unavailable: "resume storage is unavailable",
        invalid: "invalid resume storage key",
      }[reason] ?? "resume storage error",
    );
    this.name = "ResumeStorageError";
    this.reason = reason;
    this.code = "ERESUME";
  }
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const newKey = () => `${randomUUID()}.pdf`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
function checkKey(key) {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new ResumeStorageError("invalid");
  return key;
}

// --- local folder (development, tests) --------------------------------------------------------------
// The generation is the content hash: a file whose bytes changed no longer matches.
export function createLocalStorage({ dir }) {
  if (!dir) throw new Error("RESUME_LOCAL_DIR is required for local resume storage");
  const root = path.resolve(dir);
  const fileFor = (key) => path.join(root, checkKey(key));
  return {
    kind: "local",
    async put(buffer, _meta = {}) {
      const key = newKey();
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await writeFile(fileFor(key), buffer, { flag: "wx", mode: 0o600 });
      } catch {
        throw new ResumeStorageError("unavailable");
      }
      const hash = sha256(buffer);
      return { key, generation: hash, size: buffer.length, sha256: hash };
    },
    async get(key, generation) {
      const file = fileFor(key);
      let data;
      try {
        data = await readFile(file);
      } catch (err) {
        throw new ResumeStorageError(err?.code === "ENOENT" ? "not_found" : err?.code === "EACCES" ? "permission" : "unavailable");
      }
      if (sha256(data) !== String(generation)) throw new ResumeStorageError("not_found");
      return data;
    },
    async delete(key) {
      await rm(fileFor(key), { force: true }).catch(() => {
        throw new ResumeStorageError("unavailable");
      });
    },
  };
}

// --- Google Cloud Storage ----------------------------------------------------------------------------
// Application Default Credentials (the Cloud Run service account, or `gcloud auth application-default
// login` locally). `client` is injectable for tests; otherwise @google-cloud/storage is loaded on first use.
function mapGcsError(err) {
  const code = err?.code;
  if (code === 404 || code === "404") return new ResumeStorageError("not_found");
  if (code === 401 || code === 403 || code === "401" || code === "403") return new ResumeStorageError("permission");
  return new ResumeStorageError("unavailable");
}

export function createGcsStorage({ bucket, client }) {
  if (!bucket) throw new Error("RESUME_BUCKET is required for gcs resume storage");
  let cached = client;
  const getClient = async () => {
    if (!cached) {
      const { Storage } = await import("@google-cloud/storage");
      cached = new Storage();
    }
    return cached;
  };
  const file = async (key, opts) => (await getClient()).bucket(bucket).file(checkKey(key), opts);
  return {
    kind: "gcs",
    async put(buffer, _meta = {}) {
      const key = newKey();
      try {
        const f = await file(key);
        // ifGenerationMatch 0: create only, never overwrite an existing object.
        await f.save(buffer, { resumable: false, contentType: "application/pdf", preconditionOpts: { ifGenerationMatch: 0 } });
        const [meta] = await f.getMetadata();
        return { key, generation: String(meta.generation), size: buffer.length, sha256: sha256(buffer) };
      } catch (err) {
        throw err instanceof ResumeStorageError ? err : mapGcsError(err);
      }
    },
    async get(key, generation) {
      try {
        const f = await file(key, { generation: String(generation) });
        const [data] = await f.download();
        return data;
      } catch (err) {
        throw err instanceof ResumeStorageError ? err : mapGcsError(err);
      }
    },
    async delete(key) {
      try {
        await (await file(key)).delete({ ignoreNotFound: true });
      } catch (err) {
        throw err instanceof ResumeStorageError ? err : mapGcsError(err);
      }
    },
  };
}

export function createResumeStorage(config, { client } = {}) {
  if (config?.resumeStorage === "gcs") {
    if (!config.resumeBucket) throw new Error("RESUME_BUCKET is required when RESUME_STORAGE=gcs");
    return createGcsStorage({ bucket: config.resumeBucket, client });
  }
  return createLocalStorage({ dir: config?.resumeLocalDir ?? "./data/resumes" });
}
