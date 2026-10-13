// Preview-table selection. POST /api/batches returns each contact with its own CSV `row`
// (data rows start at 2, see src/import/parseCsv.js); warnings refer to the same numbers.
import type { ContactStatus, ContactWithPreview, RowWarning, UploadedContact } from "./types";

/** A cross-batch duplicate with one of these statuses is refused by the server. */
const BLOCKING: ReadonlySet<ContactStatus> = new Set(["replied", "bounced", "opted_out"]);

export interface PreviewRow {
  contact: ContactWithPreview;
  row: number;
  warning: RowWarning | null;
  /** Cannot be scheduled (the server would refuse it). */
  blocked: boolean;
}

export function buildPreviewRows(contacts: UploadedContact[], warnings: RowWarning[]): PreviewRow[] {
  const byRow = new Map(warnings.map((w) => [w.row, w]));
  return contacts.map((contact) => {
    const warning = byRow.get(contact.row) ?? null;
    return { contact, row: contact.row, warning, blocked: warning ? BLOCKING.has(warning.existingStatus) : false };
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
