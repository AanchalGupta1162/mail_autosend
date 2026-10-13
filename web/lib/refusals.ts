import type { RefusalReason } from "./types";

const STATUS_WORDS: Record<string, string> = {
  replied: "replied",
  bounced: "bounced",
  opted_out: "opted out",
  sent: "was sent",
  scheduled: "is scheduled",
  failed: "failed",
};

/** Human wording for the server's refusal codes (src/domain/schedule.js refusalReason). */
export function refusalText(reason: RefusalReason | string): string {
  switch (reason) {
    case "replied":
      return "Already replied";
    case "bounced":
      return "Address bounced";
    case "opted_out":
      return "Opted out";
    case "failed":
      return "Last send failed; check the contact before retrying";
    case "suppressed":
      return "On the suppression list";
    case "already_sent":
      return "Already sent";
    case "already_scheduled":
      return "Already scheduled; reschedule it from Contacts";
    case "not_in_batch":
      return "Not part of this batch";
  }
  const other = /^other_batch_(.+)$/.exec(reason);
  if (other) return `Same address ${STATUS_WORDS[other[1]!] ?? other[1]!.replace(/_/g, " ")} in another batch`;
  return reason.replace(/_/g, " ");
}
