import { ImapFlow } from "imapflow";

// Gmail may rewrite the Message-ID on delivery, so matching on the stored id alone can miss a
// reply. The ordered searches are: In-Reply-To, References, then (when contact details are given)
// "from the recipient, subject contains the original subject, since the send date".
export function buildReplySearches(messageId, { fromEmail, subject, since } = {}) {
  const searches = [{ header: { "in-reply-to": messageId } }, { header: { references: messageId } }];
  const clean = (v) => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
  if (clean(fromEmail) && clean(subject) && since instanceof Date) {
    searches.push({ from: fromEmail.trim().toLowerCase(), subject, since });
  }
  return searches;
}

/**
 * Returns true if the inbox contains any message whose In-Reply-To or
 * References header points at the given Message-ID — i.e. a reply to it.
 * Throws on connection/search errors; callers should treat that as
 * "unknown, skip this row" rather than "no reply".
 */
export async function checkForReply(config, messageId, opts = {}) {
  if (!messageId) return false;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      for (const query of buildReplySearches(messageId, opts)) {
        const found = await client.search(query);
        if (found && found.length > 0) return true;
      }
      return false;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
