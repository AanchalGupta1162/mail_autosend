import { existsSync, statSync } from "node:fs";
import { z } from "zod";

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      const x = v.toLowerCase();
      if (["true", "1", "yes"].includes(x)) return true;
      if (["false", "0", "no"].includes(x)) return false;
      ctx.addIssue({ code: "custom", message: "must be one of true/false/1/0/yes/no" });
      return z.NEVER;
    });

const int = (def, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

// Cap for SIGNATURE_HTML (bytes): it is appended to every mail, and env vars are not for documents.
export const MAX_SIGNATURE_HTML_BYTES = 64 * 1024;

// TRUST_PROXY = number of reverse proxies in front of Express that append to X-Forwarded-For
// (0/false/empty = none). Express then takes the client address that many hops from the right.
// "true"/CIDR/names are refused: trusting every entry would let a client choose its own IP.
const hops = () =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const x = (v ?? "").trim().toLowerCase();
      if (x === "" || x === "0" || x === "false") return 0;
      if (/^[1-5]$/.test(x)) return Number(x);
      ctx.addIssue({ code: "custom", message: "must be 0 (off) or the number of proxy hops, 1-5" });
      return z.NEVER;
    });

const schema = z
  .object({
    DATABASE_URL: z.string({ error: "DATABASE_URL is required" }).min(1, "DATABASE_URL is required"),
    SESSION_SECRET: z
      .string({ error: "SESSION_SECRET is required" })
      .min(32, "SESSION_SECRET must be at least 32 characters"),
    NODE_ENV: z.enum(["development", "production", "test"]).optional().default("development"),
    PORT: int(3000, 1),
    DRY_RUN: bool(true),
    DAILY_SEND_CAP: int(100, 0),
    MAX_PER_TICK: int(5, 1),
    POLL_INTERVAL_SECONDS: int(30, 1),
    REPLY_SWEEP_ENABLED: bool(true),
    SEND_GAP_SECONDS_MIN: int(15, 0),
    SEND_GAP_SECONDS_MAX: int(45, 0),
    TRUST_PROXY: hops(),
    GMAIL_USER: z.string().optional(),
    GMAIL_APP_PASSWORD: z.string().optional(),
    FROM_NAME: z.string().optional(),
    RESUME_PATH: z.string().optional(),
    SIGNATURE_PATH: z.string().optional(),
    SIGNATURE_HTML: z
      .string()
      .optional()
      .refine((v) => v === undefined || Buffer.byteLength(v, "utf8") <= MAX_SIGNATURE_HTML_BYTES, {
        message: `SIGNATURE_HTML must be at most ${MAX_SIGNATURE_HTML_BYTES} bytes`,
      }),
    WORKER_MODE: z.enum(["polling", "scheduled"], { error: "WORKER_MODE must be polling or scheduled" }).optional().default("polling"),
    INTERNAL_AUDIENCE: z.string().trim().optional(),
    INTERNAL_INVOKER_SA: z.string().trim().optional(),
    INTERNAL_TICK_DEADLINE_SECONDS: int(540, 1, 3600),
    SEND_WINDOW_ENFORCED: bool(false),
    SWEEP_MAX_AGE_MINUTES: int(90, 5, 1440),
    MIGRATE_ON_START: bool(true),
    RESUME_STORAGE: z.enum(["local", "gcs"], { error: "RESUME_STORAGE must be local or gcs" }).optional().default("local"),
    RESUME_BUCKET: z.string().trim().optional(),
    RESUME_LOCAL_DIR: z.string().optional(),
  })
  .refine((e) => e.SEND_GAP_SECONDS_MIN <= e.SEND_GAP_SECONDS_MAX, {
    message: "SEND_GAP_SECONDS_MIN must be <= SEND_GAP_SECONDS_MAX",
    path: ["SEND_GAP_SECONDS_MAX"],
  })
  .superRefine((e, ctx) => {
    if (e.RESUME_STORAGE !== "gcs") return;
    // GCS bucket naming: 3-63 chars of lower-case letters, digits, dashes, underscores, dots.
    if (!e.RESUME_BUCKET) ctx.addIssue({ code: "custom", path: ["RESUME_BUCKET"], message: "RESUME_BUCKET is required when RESUME_STORAGE=gcs" });
    else if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(e.RESUME_BUCKET)) {
      ctx.addIssue({ code: "custom", path: ["RESUME_BUCKET"], message: "RESUME_BUCKET is not a valid bucket name" });
    }
  })
  .superRefine((e, ctx) => {
    // Scheduled mode is driven by Cloud Scheduler through /internal/*; without both values nothing could ever
    // authenticate, so refuse to start rather than run a server that silently never sends.
    if (e.WORKER_MODE !== "scheduled") return;
    for (const key of ["INTERNAL_AUDIENCE", "INTERNAL_INVOKER_SA"]) {
      if (!e[key]) ctx.addIssue({ code: "custom", path: [key], message: `${key} is required when WORKER_MODE=scheduled` });
    }
  })
  .superRefine((e, ctx) => {
    if (e.DRY_RUN) return;
    // Fail fast: a real run must never go out without the signature. SIGNATURE_HTML (inline, e.g. from a
    // secret store) replaces the file. RESUME_PATH is only the legacy fallback for messages with no
    // library resume: optional, but if set it must exist.
    const hasInlineSignature = Boolean(e.SIGNATURE_HTML?.trim());
    const required = [["SIGNATURE_PATH", !hasInlineSignature], ["RESUME_PATH", false]];
    for (const [key, mandatory] of required) {
      const p = e[key]?.trim();
      if (!p && !mandatory) continue;
      if (key === "SIGNATURE_PATH" && hasInlineSignature) continue;
      const isFile = p && existsSync(p) && statSync(p).isFile();
      if (!isFile) ctx.addIssue({ code: "custom", path: [key], message: `${key} must point to an existing file when DRY_RUN=false` });
    }
  })
  .refine((e) => e.DRY_RUN || (e.GMAIL_USER && e.GMAIL_APP_PASSWORD), {
    message: "GMAIL_USER and GMAIL_APP_PASSWORD are required when DRY_RUN=false",
    path: ["GMAIL_USER"],
  });

// Validates env vars. Error messages name the variable but never echo its value.
export function loadServerConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join(".") || "env"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration: ${msg}`);
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    dryRun: e.DRY_RUN,
    dailySendCap: e.DAILY_SEND_CAP,
    maxPerTick: e.MAX_PER_TICK,
    pollIntervalSeconds: e.POLL_INTERVAL_SECONDS,
    replySweepEnabled: e.REPLY_SWEEP_ENABLED,
    sendGapSecondsMin: e.SEND_GAP_SECONDS_MIN,
    sendGapSecondsMax: e.SEND_GAP_SECONDS_MAX,
    trustProxy: e.TRUST_PROXY,
    gmailUser: e.GMAIL_USER ?? "",
    gmailAppPassword: e.GMAIL_APP_PASSWORD ?? "",
    fromName: e.FROM_NAME?.trim() || undefined,
    resumePath: e.RESUME_PATH?.trim() || undefined,
    signaturePath: e.SIGNATURE_PATH?.trim() || undefined,
    signatureHtml: e.SIGNATURE_HTML?.trim() ? e.SIGNATURE_HTML : undefined,
    workerMode: e.WORKER_MODE,
    internalAudience: e.INTERNAL_AUDIENCE || undefined,
    internalInvokerSa: e.INTERNAL_INVOKER_SA || undefined,
    internalTickDeadlineSeconds: e.INTERNAL_TICK_DEADLINE_SECONDS,
    sendWindowEnforced: e.SEND_WINDOW_ENFORCED,
    sweepMaxAgeMinutes: e.SWEEP_MAX_AGE_MINUTES,
    migrateOnStart: e.MIGRATE_ON_START,
    resumeStorage: e.RESUME_STORAGE,
    resumeBucket: e.RESUME_BUCKET || undefined,
    resumeLocalDir: e.RESUME_LOCAL_DIR?.trim() || "./data/resumes",
  };
}

const adminSchema = z.object({
  ADMIN_USERNAME: z
    .string({ error: "ADMIN_USERNAME is required" })
    .min(3, "ADMIN_USERNAME must be at least 3 characters")
    .regex(/^[^\s\p{Cc}]+$/u, "ADMIN_USERNAME must not contain whitespace or control characters"),
  ADMIN_PASSWORD: z
    .string({ error: "ADMIN_PASSWORD is required" })
    .min(10, "ADMIN_PASSWORD must be at least 10 characters"),
});

// Used by scripts/seedAdmin.js. Errors name the variable, never echo its value.
export function loadAdminSeedConfig(env = process.env) {
  const result = adminSchema.safeParse(env);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid admin configuration: ${msg}`);
  }
  return { username: result.data.ADMIN_USERNAME, password: result.data.ADMIN_PASSWORD };
}
