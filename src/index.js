import { loadConfig } from "./config.js";
import {
  openSheet,
  getAllRows,
  markInitialSent,
  markFollowUpSent,
  markReplied,
  markDone,
  markFailed,
  save,
} from "./excel.js";
import { createTransport, buildInitialMailOptions, buildFollowUpMailOptions, send } from "./mailer.js";
import { checkForReply } from "./imap.js";
import { buildJobs } from "./scheduler.js";
import { computeDelayMs, processQueue } from "./queue.js";

async function checkReplies(sheet, config, rows) {
  const checkable = rows.filter(
    (row) => row.status === "Sent" && row.followUpCount < config.followUpMaxCount
  );
  for (const row of checkable) {
    try {
      const replied = await checkForReply(config, row.messageId);
      if (replied) {
        console.log(`${row.person} <${row.email}> replied — stopping follow-ups.`);
        markReplied(sheet, row.rowNumber);
      }
    } catch (error) {
      console.warn(`Couldn't check replies for ${row.email}: ${error.message} (will retry next run)`);
    }
  }
  if (checkable.length > 0) await save(sheet);
}

function jobLabel(job) {
  const { row } = job;
  const kind = job.type === "initial" ? "initial email" : `follow-up #${job.followUpNumber}`;
  return `${kind} to ${row.person} <${row.email}> (${row.role} @ ${row.company})`;
}

async function main() {
  const config = loadConfig();
  const sheet = await openSheet(config.excelPath);

  if (!config.dryRun) {
    await checkReplies(sheet, config, getAllRows(sheet));
  }

  const rows = getAllRows(sheet);
  const { jobs, doneUpdates } = buildJobs(rows, {
    followUpIntervalDays: config.followUpIntervalDays,
    followUpMaxCount: config.followUpMaxCount,
  });

  for (const row of doneUpdates) {
    console.log(`${row.person} <${row.email}> exhausted follow-ups with no reply — marking Done.`);
    markDone(sheet, row.rowNumber);
  }
  if (doneUpdates.length > 0) await save(sheet);

  if (jobs.length === 0) {
    console.log("Nothing to send — no new rows and no follow-ups due.");
    return;
  }

  const delayMs = computeDelayMs(config.windowMinutes, jobs.length);
  console.log(
    `${jobs.length} email(s) to send, spaced ~${Math.round(delayMs / 1000)}s apart ` +
      `(target window: ${config.windowMinutes}min)${config.dryRun ? " [DRY RUN]" : ""}`
  );

  const transport = config.dryRun ? null : createTransport(config);
  let sentCount = 0;
  let failedCount = 0;

  await processQueue(jobs, delayMs, async (job) => {
    const label = jobLabel(job);
    const { row } = job;

    if (config.dryRun) {
      const subject = job.type === "initial" ? row.subject : `Re: ${row.subject}`;
      console.log(`[DRY RUN] Would send ${label} — subject: "${subject}"`);
      sentCount++;
      return;
    }

    try {
      const mailOptions =
        job.type === "initial" ? buildInitialMailOptions(config, row) : buildFollowUpMailOptions(config, row);
      const messageId = await send(transport, mailOptions);
      console.log(`Sent ${label}`);

      if (job.type === "initial") {
        markInitialSent(sheet, row.rowNumber, { messageId, sentAt: new Date() });
      } else {
        markFollowUpSent(sheet, row.rowNumber, { sentAt: new Date(), followUpCount: job.followUpNumber });
      }
      sentCount++;
    } catch (error) {
      console.error(`Failed to send ${label}: ${error.message}`);
      markFailed(sheet, row.rowNumber, error.message);
      failedCount++;
    } finally {
      await save(sheet);
    }
  });

  console.log(`Done. Sent: ${sentCount}, Failed: ${failedCount}.`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
