// Preview-table selection. Rows come back from POST /api/batches in file order; rejected rows
// are not inserted, so a contact's CSV row is the n-th row number not listed in `errors`
// (data rows start at 2, see src/import/parseCsv.js).
import type { ContactStatus, ContactWithPreview, RowIssue, RowWarning } from "./types";

/** A cross-batch duplicate with one of these statuses is refused by the server. */
const BLOCKING: ReadonlySet<ContactStatus> = new Set(["replied", "bounced", "opted_out"]);

export interface PreviewRow {
  contact: ContactWithPreview;
  row: number;
  warning: RowWarning | null;
  /** Cannot be scheduled (the server would refuse it). */
  blocked: boolean;
}

export function buildPreviewRows(contacts: ContactWithPreview[], errors: RowIssue[], warnings: RowWarning[]): PreviewRow[] {
  const rejected = new Set(errors.map((e) => e.row));
  const byRow = new Map(warnings.map((w) => [w.row, w]));
  let row = 1;
  return contacts.map((contact) => {
    do row++;
    while (rejected.has(row));
    const warning = byRow.get(row) ?? null;
    return { contact, row, warning, blocked: warning ? BLOCKING.has(warning.existingStatus) : false };
  });
}

const selectable = (rows: PreviewRow[]) => rows.filter((r) => !r.blocked);

/** Clean rows start selected; any row with a cross-batch warning needs an explicit tick. */
export function initialSelection(rows: PreviewRow[]): string[] {
  return rows.filter((r) => !r.blocked && !r.warning).map((r) => r.contact.id);
}

/** Toggles one row, keeping table order. Blocked rows cannot be selected. */
export function toggle(rows: PreviewRow[], selected: string[], id: string): string[] {
  const set = new Set(selected);
  if (set.has(id)) set.delete(id);
  else if (rows.some((r) => r.contact.id === id && !r.blocked)) set.add(id);
  return rows.filter((r) => set.has(r.contact.id)).map((r) => r.contact.id);
}

export function setAll(rows: PreviewRow[], checked: boolean): string[] {
  return checked ? selectable(rows).map((r) => r.contact.id) : [];
}

export function selectionState(rows: PreviewRow[], selected: string[]): "none" | "some" | "all" {
  const ids = new Set(selected);
  const pick = selectable(rows);
  const n = pick.filter((r) => ids.has(r.contact.id)).length;
  if (n === 0) return "none";
  return n === pick.length ? "all" : "some";
}
