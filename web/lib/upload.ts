// Client-side pre-checks matching src/server/routes/batches.js (1MB, .csv only; 500 rows is
// enforced by the server). The server remains the authority.
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const MAX_ROWS = 500;

export function checkCsvFile(file: File): string | null {
  if (!/\.csv$/i.test(file.name)) return "Choose a .csv file (export the sheet as CSV first).";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "That file is over the 1 MB limit. Split it into smaller files.";
  return null;
}
