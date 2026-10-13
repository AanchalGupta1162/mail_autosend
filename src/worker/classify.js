// Decides what a nodemailer/SMTP error means for double-send safety.
//
//   retry     PROVABLY nothing was delivered: connect-time failure (DNS, refused, connect/greeting
//             timeout) or the server refused us at EHLO/STARTTLS/AUTH/MAIL FROM/RCPT TO with a 4xx/5xx.
//   permanent as above, but a 5xx on MAIL FROM / RCPT TO: retrying is pointless.
//   hold      the queue itself cannot send and retrying will not help: rejected credentials (EAUTH) or a
//             missing/unreadable local file (signature, legacy resume) or a library resume that could not be fetched (ERESUME). Nothing was sent; the caller puts
//             the message back without consuming an attempt and surfaces the problem.
//   ambiguous anything else. NEVER retried: the row goes to needs_review.
//
// Why the default is "ambiguous": nodemailer tags every socket-level event (error, close, timeout,
// protocol error) with command "CONN" REGARDLESS of the SMTP phase, and overwrites the errno code
// with ESOCKET / ECONNECTION / ETIMEDOUT / EPROTOCOL. A reset after the server accepted DATA
// therefore looks exactly like "CONN". So "CONN" is only trusted when the error itself proves it
// happened while connecting (see isConnectTime). Any 2xx/3xx response code means the server was
// still talking to us positively, so it is ambiguous.
const SMTP_STEP_COMMANDS = new Set(["EHLO", "HELO", "STARTTLS", "AUTH", "AUTH PLAIN", "AUTH LOGIN", "AUTH XOAUTH2", "AUTH CRAM-MD5", "MAIL FROM", "RCPT TO"]);
const CONNECT_SYSCALL_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN"]);
// Local failures raised before any network traffic.
const LOCAL_CODES = new Set(["EDNS", "ENOENT", "EACCES"]);

function describe(err) {
  if (!err || typeof err !== "object") return "unknown error";
  const parts = [err.code ?? err.name ?? "Error"];
  if (err.command) parts.push(`at ${err.command}`);
  if (err.responseCode) parts.push(String(err.responseCode));
  const msg = typeof err.message === "string" ? err.message.replace(/[\r\n\p{Cc}]+/gu, " ").trim() : "";
  return `${parts.join(" ")}${msg ? `: ${msg}` : ""}`.slice(0, 240);
}

function isConnectTime(err) {
  if (err.code === "EDNS") return true;
  if (err.code === "ETIMEDOUT" && /Connection timeout|Greeting never received/i.test(String(err.message))) return true;
  if (err.code === "ESOCKET" && err.syscall === "connect" && CONNECT_SYSCALL_CODES.has(String(err.message).match(/\b(E[A-Z]+)\b/)?.[1] ?? err.errno)) return true;
  if (err.syscall === "connect" && CONNECT_SYSCALL_CODES.has(err.code)) return true;
  return false;
}

export function classifySendError(err) {
  const description = describe(err);
  if (!err || typeof err !== "object") return { outcome: "ambiguous", description };
  const { command, code } = err;
  const responseCode = Number(err.responseCode) || 0;
  const ambiguous = { outcome: "ambiguous", description };

  if (responseCode >= 200 && responseCode < 400) return ambiguous;

  if ((code === "EAUTH" || code === "ENOENT" || code === "EACCES" || code === "ERESUME") && command !== "DATA") return { outcome: "hold", description };

  if (SMTP_STEP_COMMANDS.has(command)) {
    // A server rejection (4xx/5xx) at a pre-DATA step, or a local auth/envelope error without a response.
    const rejected = responseCode >= 400;
    const localAuth = !responseCode && (code === "EAUTH" || code === "EENVELOPE");
    if (!rejected && !localAuth) return ambiguous;
    if (responseCode >= 500 && (command === "RCPT TO" || command === "MAIL FROM")) return { outcome: "permanent", description };
    return { outcome: "retry", description };
  }

  if (command === "CONN" || !command) {
    if (isConnectTime(err)) return { outcome: "retry", description };
    if (!command && LOCAL_CODES.has(code)) return { outcome: "retry", description };
    if (!command && code === "EAUTH") return { outcome: "retry", description };
  }
  return ambiguous;
}
