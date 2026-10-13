import { createHash } from "node:crypto";

// In-process stand-in for the subset of @google-cloud/storage that src/storage/resumes.js uses:
//   client.bucket(name).file(key, { generation }) -> { save, download, getMetadata, delete }
// It mimics a bucket with Object Versioning ON (older generations stay readable when overwritten) and
// object generations and the ifGenerationMatch precondition. It is NOT the real service:
// the real adapter is untested against GCS from this repo (no cloud access in tests).
export class FakeGcsClient {
  constructor() {
    this.objects = new Map(); // `${bucket}/${key}` -> [{ gen, data }, ...] oldest first
    this.nextGen = 1_700_000_000_000_000;
    this.saves = [];
    this.reads = [];
    this.failures = [];
  }
  failNext(err) {
    this.failures.push(Object.assign(new Error(err.message), { code: err.code }));
  }
  overwrite(bucket, key, data) {
    const id = `${bucket}/${key}`;
    this.objects.set(id, [...(this.objects.get(id) ?? []), { gen: String(this.nextGen++), data: Buffer.from(data) }]);
  }
  bucket(bucketName) {
    const self = this;
    return {
      file(key, opts = {}) {
        const id = `${bucketName}/${key}`;
        const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
        return {
          async save(data, saveOpts = {}) {
            self.saves.push({ key, ...saveOpts });
            if (saveOpts.preconditionOpts?.ifGenerationMatch === 0 && self.objects.has(id)) {
              throw Object.assign(new Error("Precondition failed"), { code: 412 });
            }
            self.overwrite(bucketName, key, data);
          },
          async getMetadata() {
            const cur = self.objects.get(id)?.at(-1);
            if (!cur) throw notFound();
            return [{ generation: cur.gen, size: String(cur.data.length), md5Hash: createHash("md5").update(cur.data).digest("base64") }];
          },
          async download() {
            self.reads.push({ key, generation: opts.generation });
            const failure = self.failures.shift();
            if (failure) throw failure;
            const versions = self.objects.get(id) ?? [];
            // Without a generation: the live object. With one: only that exact generation.
            const cur = opts.generation === undefined ? versions.at(-1) : versions.find((v) => v.gen === String(opts.generation));
            if (!cur) throw notFound();
            return [Buffer.from(cur.data)];
          },
          async delete(delOpts = {}) {
            if (!self.objects.delete(id) && !delOpts.ignoreNotFound) throw notFound();
          },
        };
      },
    };
  }
}
