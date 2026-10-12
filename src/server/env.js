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

const int = (def, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min));

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
    SEND_GAP_SECONDS_MIN: int(15, 0),
    SEND_GAP_SECONDS_MAX: int(45, 0),
    TRUST_PROXY: z.string().optional().transform((v) => v === "1"),
    GMAIL_USER: z.string().optional(),
    GMAIL_APP_PASSWORD: z.string().optional(),
    FROM_NAME: z.string().optional(),
    RESUME_PATH: z.string().optional(),
    SIGNATURE_PATH: z.string().optional(),
  })
  .refine((e) => e.SEND_GAP_SECONDS_MIN <= e.SEND_GAP_SECONDS_MAX, {
    message: "SEND_GAP_SECONDS_MIN must be <= SEND_GAP_SECONDS_MAX",
    path: ["SEND_GAP_SECONDS_MAX"],
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
    sendGapSecondsMin: e.SEND_GAP_SECONDS_MIN,
    sendGapSecondsMax: e.SEND_GAP_SECONDS_MAX,
    trustProxy: e.TRUST_PROXY,
    gmailUser: e.GMAIL_USER ?? "",
    gmailAppPassword: e.GMAIL_APP_PASSWORD ?? "",
    fromName: e.FROM_NAME?.trim() || undefined,
    resumePath: e.RESUME_PATH?.trim() || undefined,
    signaturePath: e.SIGNATURE_PATH?.trim() || undefined,
  };
}
