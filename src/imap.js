import { ImapFlow } from "imapflow";

/**
 * Returns true if the inbox contains any message whose In-Reply-To or
 * References header points at the given Message-ID — i.e. a reply to it.
 * Throws on connection/search errors; callers should treat that as
 * "unknown, skip this row" rather than "no reply".
 */
export async function checkForReply(config, messageId) {
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
      const byInReplyTo = await client.search({ header: { "in-reply-to": messageId } });
      if (byInReplyTo && byInReplyTo.length > 0) return true;

      const byReferences = await client.search({ header: { references: messageId } });
      return Boolean(byReferences && byReferences.length > 0);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
