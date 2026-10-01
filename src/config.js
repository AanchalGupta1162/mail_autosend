import { readFileSync, existsSync } from "node:fs";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadSignatureHtml(signaturePath) {
  if (!signaturePath) return "";
  if (!existsSync(signaturePath)) {
    console.warn(`Signature file not found at "${signaturePath}" — sending without a signature.`);
    return "";
  }
  return readFileSync(signaturePath, "utf8");
}

export function loadConfig() {
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";
  const resumePath = process.env.RESUME_PATH?.trim() || undefined;

  if (resumePath && !dryRun && !existsSync(resumePath)) {
    throw new Error(`RESUME_PATH is set to "${resumePath}" but that file doesn't exist.`);
  }

  return {
    gmailUser: dryRun ? process.env.GMAIL_USER ?? "" : required("GMAIL_USER"),
    gmailAppPassword: dryRun
      ? process.env.GMAIL_APP_PASSWORD ?? ""
      : required("GMAIL_APP_PASSWORD"),
    excelPath: process.env.EXCEL_PATH ?? "./sample-recruiters.xlsx",
    fromName: process.env.FROM_NAME?.trim() || undefined,
    windowMinutes: Number(process.env.WINDOW_MINUTES ?? "60"),
    dryRun,
    resumePath,
    signatureHtml: loadSignatureHtml(process.env.SIGNATURE_PATH?.trim()),
    followUpIntervalDays: Number(process.env.FOLLOWUP_INTERVAL_DAYS ?? "7"),
    followUpMaxCount: Number(process.env.FOLLOWUP_MAX_COUNT ?? "3"),
  };
}
