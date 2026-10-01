import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  openSheet,
  getAllRows,
  markInitialSent,
  markFollowUpSent,
  markReplied,
  markDone,
  markFailed,
  save,
} from "../src/excel.js";

async function writeTestSheet(filePath, rows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Recruiters");
  worksheet.columns = [
    { header: "Company", key: "company" },
    { header: "Role", key: "role" },
    { header: "Person", key: "person" },
    { header: "Email", key: "email" },
    { header: "Subject", key: "subject" },
    { header: "Mail Text", key: "mailText" },
    { header: "Follow-up Text", key: "followUpText" },
    { header: "Status", key: "status" },
  ];
  for (const row of rows) worksheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
}

async function withTempSheet(rows, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "mail-autosend-test-"));
  const filePath = path.join(dir, "test.xlsx");
  await writeTestSheet(filePath, rows);
  try {
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("getAllRows skips blank rows but keeps everything else, parsing lastSentAt/followUpCount", async () => {
  await withTempSheet(
    [
      { company: "A", role: "R1", person: "P1", email: "a@x.com", subject: "S1", mailText: "T1", followUpText: "F1", status: "" },
      { company: "B", role: "R2", person: "P2", email: "b@x.com", subject: "S2", mailText: "T2", followUpText: "F2", status: "Sent" },
      { company: "", role: "", person: "", email: "", subject: "", mailText: "", followUpText: "", status: "" },
    ],
    async (filePath) => {
      const sheet = await openSheet(filePath);
      const rows = getAllRows(sheet);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].status, "");
      assert.equal(rows[1].status, "Sent");
      assert.equal(rows[1].followUpCount, 0);
      assert.equal(rows[1].lastSentAt, null);
    }
  );
});

test("markInitialSent then markFollowUpSent progress a row's state and persist", async () => {
  await withTempSheet(
    [{ company: "A", role: "R1", person: "P1", email: "a@x.com", subject: "S1", mailText: "T1", followUpText: "F1", status: "" }],
    async (filePath) => {
      const sheet = await openSheet(filePath);
      const [row] = getAllRows(sheet);

      markInitialSent(sheet, row.rowNumber, { messageId: "<abc@mail>", sentAt: new Date("2026-01-01T09:00:00Z") });
      await save(sheet);

      let reopened = await openSheet(filePath);
      let [updated] = getAllRows(reopened);
      assert.equal(updated.status, "Sent");
      assert.equal(updated.messageId, "<abc@mail>");
      assert.equal(updated.followUpCount, 0);
      assert.equal(updated.lastSentAt.toISOString(), "2026-01-01T09:00:00.000Z");

      markFollowUpSent(reopened, updated.rowNumber, { sentAt: new Date("2026-01-08T09:00:00Z"), followUpCount: 1 });
      await save(reopened);

      reopened = await openSheet(filePath);
      [updated] = getAllRows(reopened);
      assert.equal(updated.status, "Sent");
      assert.equal(updated.followUpCount, 1);
      assert.equal(updated.lastSentAt.toISOString(), "2026-01-08T09:00:00.000Z");
    }
  );
});

test("markReplied, markDone, markFailed set the expected status", async () => {
  await withTempSheet(
    [
      { company: "A", role: "R1", person: "P1", email: "a@x.com", subject: "S1", mailText: "T1", followUpText: "F1", status: "Sent" },
      { company: "B", role: "R2", person: "P2", email: "b@x.com", subject: "S2", mailText: "T2", followUpText: "F2", status: "Sent" },
      { company: "C", role: "R3", person: "P3", email: "c@x.com", subject: "S3", mailText: "T3", followUpText: "F3", status: "" },
    ],
    async (filePath) => {
      const sheet = await openSheet(filePath);
      const [row1, row2, row3] = getAllRows(sheet);

      markReplied(sheet, row1.rowNumber);
      markDone(sheet, row2.rowNumber);
      markFailed(sheet, row3.rowNumber, "bad address");
      await save(sheet);

      const reopened = await openSheet(filePath);
      const [u1, u2, u3] = getAllRows(reopened);
      assert.equal(u1.status, "Replied");
      assert.equal(u2.status, "Done");
      assert.equal(u3.status, "Failed");
    }
  );
});

test("openSheet throws a clear error when a required column is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mail-autosend-test-"));
  const filePath = path.join(dir, "bad.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Recruiters");
    worksheet.columns = [{ header: "Company", key: "company" }];
    worksheet.addRow({ company: "A" });
    await workbook.xlsx.writeFile(filePath);

    await assert.rejects(() => openSheet(filePath), /missing required column/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CSV files are read and written, including quoted multi-line cells", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mail-autosend-test-"));
  const filePath = path.join(dir, "test.csv");
  try {
    await writeFile(
      filePath,
      '"Company","Role","Person","Email","Subject","Mail Text","Follow-up Text"\n' +
        '"A","R1","P1","a@x.com","S1","Hi P1,\n\nSee **R1**, ok.\n\nBest,\nH","F1"\n'
    );
    const sheet = await openSheet(filePath);
    const [row] = getAllRows(sheet);
    assert.equal(row.mailText, "Hi P1,\n\nSee **R1**, ok.\n\nBest,\nH");

    markInitialSent(sheet, row.rowNumber, { messageId: "<m@x>", sentAt: new Date("2026-01-01T09:00:00Z") });
    await save(sheet);

    const [updated] = getAllRows(await openSheet(filePath));
    assert.equal(updated.status, "Sent");
    assert.equal(updated.mailText, row.mailText);
    assert.equal(updated.lastSentAt.toISOString(), "2026-01-01T09:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
