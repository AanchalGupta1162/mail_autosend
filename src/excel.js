import ExcelJS from "exceljs";

const HEADERS = {
  company: "Company",
  role: "Role",
  person: "Person",
  email: "Email",
  subject: "Subject",
  mailText: "Mail Text",
  followUpText: "Follow-up Text",
  status: "Status",
  messageId: "Message ID",
  lastSentAt: "Last Sent At",
  followUpCount: "Follow-up Count",
  error: "Error",
};

const REQUIRED_KEYS = ["company", "role", "person", "email", "subject", "mailText"];
const APP_OWNED_KEYS = ["status", "messageId", "lastSentAt", "followUpCount", "error"];

function buildHeaderIndex(headerRow) {
  const index = {};
  headerRow.eachCell((cell, colNumber) => {
    const value = String(cell.value ?? "").trim();
    const key = Object.keys(HEADERS).find((k) => HEADERS[k] === value);
    if (key) index[key] = colNumber;
  });
  for (const key of REQUIRED_KEYS) {
    if (!index[key]) {
      throw new Error(`Excel sheet is missing required column: "${HEADERS[key]}"`);
    }
  }
  return index;
}

export async function openSheet(excelPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("No worksheet found in the Excel file");

  const headerRow = worksheet.getRow(1);
  const columns = buildHeaderIndex(headerRow);

  // Add any app-owned columns the sheet doesn't have yet (followUpText is
  // user-authored but optional, so it's included here too).
  for (const key of [...APP_OWNED_KEYS, "followUpText"]) {
    if (!columns[key]) {
      const colNumber = headerRow.cellCount + 1;
      headerRow.getCell(colNumber).value = HEADERS[key];
      columns[key] = colNumber;
    }
  }

  return { workbook, worksheet, columns, excelPath };
}

function cellText({ worksheet, columns }, rowNumber, key) {
  return String(worksheet.getRow(rowNumber).getCell(columns[key]).value ?? "").trim();
}

export function getAllRows(sheet) {
  const { worksheet } = sheet;
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const email = cellText(sheet, rowNumber, "email");
    if (!email) return; // blank row

    const lastSentAtRaw = cellText(sheet, rowNumber, "lastSentAt");
    const followUpCountRaw = cellText(sheet, rowNumber, "followUpCount");

    rows.push({
      rowNumber,
      company: cellText(sheet, rowNumber, "company"),
      role: cellText(sheet, rowNumber, "role"),
      person: cellText(sheet, rowNumber, "person"),
      email,
      subject: cellText(sheet, rowNumber, "subject"),
      mailText: cellText(sheet, rowNumber, "mailText"),
      followUpText: cellText(sheet, rowNumber, "followUpText"),
      status: cellText(sheet, rowNumber, "status"),
      messageId: cellText(sheet, rowNumber, "messageId") || null,
      lastSentAt: lastSentAtRaw ? new Date(lastSentAtRaw) : null,
      followUpCount: followUpCountRaw ? Number(followUpCountRaw) : 0,
    });
  });
  return rows;
}

export function markInitialSent({ worksheet, columns }, rowNumber, { messageId, sentAt }) {
  const row = worksheet.getRow(rowNumber);
  row.getCell(columns.status).value = "Sent";
  row.getCell(columns.messageId).value = messageId ?? "";
  row.getCell(columns.lastSentAt).value = sentAt.toISOString();
  row.getCell(columns.followUpCount).value = 0;
  row.getCell(columns.error).value = "";
}

export function markFollowUpSent({ worksheet, columns }, rowNumber, { sentAt, followUpCount }) {
  const row = worksheet.getRow(rowNumber);
  row.getCell(columns.status).value = "Sent";
  row.getCell(columns.lastSentAt).value = sentAt.toISOString();
  row.getCell(columns.followUpCount).value = followUpCount;
  row.getCell(columns.error).value = "";
}

export function markReplied({ worksheet, columns }, rowNumber) {
  worksheet.getRow(rowNumber).getCell(columns.status).value = "Replied";
}

export function markDone({ worksheet, columns }, rowNumber) {
  worksheet.getRow(rowNumber).getCell(columns.status).value = "Done";
}

export function markFailed({ worksheet, columns }, rowNumber, errorMessage) {
  const row = worksheet.getRow(rowNumber);
  row.getCell(columns.status).value = "Failed";
  row.getCell(columns.error).value = errorMessage;
}

export async function save({ workbook, excelPath }) {
  await workbook.xlsx.writeFile(excelPath);
}
