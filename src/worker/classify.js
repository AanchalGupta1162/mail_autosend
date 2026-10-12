// Decides what a nodemailer/SMTP error means for double-send safety.
//
//   retry     nothing was (or could have been) delivered: connect/DNS/TLS/auth failure or the
//             server refused sender/recipient BEFORE the DATA phase began. Safe to try again.
//   permanent nothing was delivered and retrying is pointless (5xx on MAIL FROM / RCPT TO).
//   ambiguous the message may have been accepted, or we cannot tell (timeout, reset or any error
//             at/after DATA, an unknown error shape). NEVER retried: it goes to needs_review.
//
// nodemailer sets err.command to the SMTP step that failed ("CONN", "EHLO", "AUTH PLAIN",
// "MAIL FROM", "RCPT TO", "DATA", ...). Only a command that is positively before DATA counts as
// safe; everything else defaults to ambiguous.
const PRE_DATA_COMMANDS = new Set([
  "CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "AUTH PLAIN", "AUTH LOGIN", "AUTH XOAUTH2", "AUTH CRAM-MD5", "MAIL FROM", "RCPT TO",
]);
// Errors raised locally or at connect time, with no SMTP command attached, where nothing was transmitted.
const NOTHING_SENT_CODES = new Set(["EDNS", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAUTH", "ENOENT", "EACCES", "EENVELOPE"]);

function describe(err) {
  if (!err || typeof err !== "object") return "unknown error";
  const parts = [err.code ?? err.name ?? "Error"];
  if (err.command) parts.push(`at ${err.command}`);
  if (err.responseCode) parts.push(String(err.responseCode));
  const msg = typeof err.message === "string" ? err.message.replace(/[\r\n\p{Cc}]+/gu, " ").trim() : "";
  return `${parts.join(" ")}${msg ? `: ${msg}` : ""}`.slice(0, 240);
}

export function classifySendError(err) {
  const description = describe(err);
  if (!err || typeof err !== "object") return { outcome: "ambiguous", description };
  const { command, code } = err;
  const responseCode = Number(err.responseCode) || 0;
  if ((command === "RCPT TO" || command === "MAIL FROM" || (code === "EENVELOPE" && !command)) && responseCode >= 500) {
    return { outcome: "permanent", description };
  }
  if (PRE_DATA_COMMANDS.has(command)) return { outcome: "retry", description };
  if (!command && NOTHING_SENT_CODES.has(code)) return { outcome: "retry", description };
  return { outcome: "ambiguous", description };
}
