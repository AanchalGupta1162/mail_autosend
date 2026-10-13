import { checkForReply } from "../imap.js";
import { markReplied } from "../domain/contacts.js";

// Contacts whose initial email was sent and who have not replied. Without an injected checker
// (real IMAP) dry-run rows are excluded: their Message-IDs never left this machine.
const CANDIDATES = `
  SELECT c.id, c.email, c.subject, m.message_id, m.sent_at
    FROM contacts c
    JOIN messages m ON m.contact_id = c.id AND m.kind = 'initial' AND m.state = 'sent' AND ($1::boolean IS NULL OR m.dry_run = $1)
   WHERE c.status = 'sent' AND c.replied_at IS NULL AND m.message_id IS NOT NULL
   ORDER BY m.sent_at, c.id`;

// Checks the inbox for replies. An IMAP failure is logged (name/code only) and aborts the sweep
// with state unchanged; it is never treated as "no reply". The next sweep retries everything.
export async function runSweep({
  pool,
  config,
  checkReply,
  logger = console,
  shouldStop = () => false,
}) {
  const injected = typeof checkReply === "function";
  if (config.dryRun && !injected) return { skipped: true, reason: "dry_run" };
  const check = injected ? checkReply : checkForReply;
  const { rows } = await pool.query(CANDIDATES, [injected ? null : false]);
  const summary = { checked: 0, replied: 0 };
  for (const row of rows) {
    if (shouldStop()) break;
    let found;
    try {
      found = await check(config, row.message_id, {
        fromEmail: row.email,
        subject: row.subject,
        since: new Date(new Date(row.sent_at).getTime() - 86_400_000),
      });
    } catch (err) {
      logger.error(`reply sweep failed: ${err?.name ?? "Error"} ${err?.code ?? ""}`.trim());
      return { ...summary, error: true };
    }
    summary.checked += 1;
    if (!found) continue;
    try {
      await markReplied(pool, row.id, { source: "imap" });
      summary.replied += 1;
    } catch (err) {
      // e.g. opted out between the SELECT and now; leave it, nothing to retry.
      logger.error(`reply sweep skip: ${err?.name ?? "Error"} ${err?.code ?? ""}`.trim());
    }
  }
  return summary;
}
