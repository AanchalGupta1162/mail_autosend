function isDue(row, now, intervalDays) {
  if (!row.lastSentAt) return false;
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  return now.getTime() - row.lastSentAt.getTime() >= intervalMs;
}

/**
 * Decides, for each row, whether it needs an initial send, a follow-up
 * send, or just a status update (no email) — never mutates the rows.
 *
 * Rows already Replied/Done/Failed are left alone (Failed rows aren't
 * auto-retried; fix the row and it's picked up again since it won't be
 * "Sent").
 */
export function buildJobs(rows, { followUpIntervalDays, followUpMaxCount, now = new Date() }) {
  const jobs = [];
  const doneUpdates = [];

  for (const row of rows) {
    if (row.status === "Replied" || row.status === "Done" || row.status === "Failed") continue;

    if (!row.status) {
      jobs.push({ type: "initial", row });
      continue;
    }

    if (row.status === "Sent") {
      if (row.followUpCount >= followUpMaxCount) {
        doneUpdates.push(row);
        continue;
      }
      if (row.followUpText && isDue(row, now, followUpIntervalDays)) {
        jobs.push({ type: "followup", row, followUpNumber: row.followUpCount + 1 });
      }
      // else: not due yet, or no follow-up text written — skip silently.
    }
  }

  return { jobs, doneUpdates };
}
