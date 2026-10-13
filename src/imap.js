import { ImapFlow } from "imapflow";

const HEADER_NAMES = ["auto-submitted", "x-autoreply", "x-autorespond", "precedence"];

// Gmail may rewrite the Message-ID on delivery, so matching on the stored id alone can miss a
// reply. Ordered searches: In-Reply-To, References, then (when contact details are given)
// "from the recipient, subject contains the original subject, since the send date".
// Each entry is tagged with `via` so the audit trail says which search matched.
export function buildReplySearches(messageId, { fromEmail, subject, since } = {}) {
  const searches = [
    { via: "in-reply-to", query: { header: { "in-reply-to": messageId } } },
    { via: "references", query: { header: { references: messageId } } },
  ];
  const clean = (v) => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
  if (clean(fromEmail) && clean(subject) && since instanceof Date) {
    searches.push({ via: "from-subject", query: { from: fromEmail.trim().toLowerCase(), subject, since } });
  }
  return searches;
}

// Raw header block -> Map(lowercase name -> unfolded value).
export function parseHeaders(raw) {
  const out = new Map();
  if (!raw) return out;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

const AUTO_SUBJECT = /^\s*(?:(?:re|fwd?)\s*:\s*)*(?:automatic reply|out of office)\b/i;

// Decides whether a search hit is a genuine human reply. Rejects auto-replies, bounces, mail
// from the sending account itself, and (for the loose fallback search) any sender that is not
// exactly the contact. headers is a Map from parseHeaders.
export function classifyReply({ from, subject, headers }, { contactEmail, ownEmail, exactFrom = false } = {}) {
  const sender = typeof from === "string" ? from.trim().toLowerCase() : "";
  if (!sender) return { ok: false, reason: "no sender" };
  const local = sender.split("@")[0];
  if (local === "mailer-daemon" || local === "postmaster") return { ok: false, reason: "bounce sender" };
  if (ownEmail && sender === String(ownEmail).trim().toLowerCase()) return { ok: false, reason: "own address" };
  const h = headers instanceof Map ? headers : new Map();
  const autoSubmitted = h.get("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") return { ok: false, reason: "auto-submitted" };
  if (h.has("x-autoreply") || h.has("x-autorespond")) return { ok: false, reason: "autoreply header" };
  if (["auto_reply", "bulk", "junk"].includes((h.get("precedence") ?? "").trim().toLowerCase())) return { ok: false, reason: "precedence" };
  if (typeof subject === "string" && AUTO_SUBJECT.test(subject)) return { ok: false, reason: "auto subject" };
  if (exactFrom && sender !== String(contactEmail ?? "").trim().toLowerCase()) return { ok: false, reason: "sender mismatch" };
  return { ok: true };
}

const imapError = (message, code, fatal) => Object.assign(new Error(message), { code, fatal });

// imapflow's search()/fetchOne() do NOT throw on failure: they return false/undefined (and drop
// the selected mailbox when the connection closes). Every such result is turned into a thrown
// error here so it can never be mistaken for "no reply". fatal = the connection itself is gone.
function assertUsable(client) {
  if (!client.usable || !client.mailbox) throw imapError("IMAP connection lost", "NoConnection", true);
}

/** Wraps an already-connected imapflow client (INBOX selected). Exported for tests. */
export function createCheckerFromClient(client, config, { onClose } = {}) {
  return {
    async check(messageId, opts = {}) {
      if (!messageId) return false;
      for (const { via, query } of buildReplySearches(messageId, opts)) {
        assertUsable(client);
        const uids = await client.search(query, { uid: true });
        if (!Array.isArray(uids)) {
          assertUsable(client);
          throw imapError("IMAP search failed", "ESEARCH", false);
        }
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { envelope: true, headers: HEADER_NAMES }, { uid: true });
          if (!msg || !msg.envelope) {
            assertUsable(client);
            throw imapError("IMAP fetch failed", "EFETCH", false);
          }
          const verdict = classifyReply(
            { from: msg.envelope.from?.[0]?.address, subject: msg.envelope.subject, headers: parseHeaders(msg.headers) },
            { contactEmail: opts.fromEmail, ownEmail: config.gmailUser, exactFrom: via === "from-subject" },
          );
          if (verdict.ok) return { matched: true, via, uid };
        }
      }
      return false;
    },
    async close() {
      if (onClose) await onClose();
    },
  };
}

/**
 * Opens ONE IMAP connection for a whole sweep. check(messageId, opts) resolves to false (genuinely
 * no reply) or { matched: true, via, uid }; any failure is thrown (fatal = connection gone) and
 * must be treated as "unknown", never as "no reply". close() must always be called.
 */
export async function createReplyChecker(config) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    logger: false,
  });
  client.on?.("error", () => {}); // surfaced through usable/mailbox checks; avoid unhandled 'error'
  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX");
  } catch (err) {
    await client.logout().catch(() => {});
    err.fatal = true;
    throw err;
  }
  return createCheckerFromClient(client, config, {
    onClose: async () => {
      try {
        lock.release();
      } finally {
        await client.logout().catch(() => {});
      }
    },
  });
}

/**
 * One-shot helper (legacy CLI): true if the inbox holds a genuine reply to messageId.
 * Throws on connection/search errors; treat that as "unknown", not "no reply".
 */
export async function checkForReply(config, messageId, opts = {}) {
  if (!messageId) return false;
  const checker = await createReplyChecker(config);
  try {
    return Boolean(await checker.check(messageId, opts));
  } finally {
    await checker.close();
  }
}
