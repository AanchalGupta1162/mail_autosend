import { describe, expect, it } from "vitest";
import { buildPreviewRows, initialSelection, selectionState, setAll, toggle } from "./selection";
import type { ContactWithPreview, RowIssue, RowWarning } from "./types";

const contact = (id: string, email = `${id}@x.com`): ContactWithPreview => ({
  id,
  batchId: "b",
  company: "Acme",
  role: "SWE",
  person: "Jo Smith",
  email,
  subject: "s",
  mailText: "m",
  followupText: null,
  status: "uploaded",
  followupRequested: false,
  followupDelayDays: 7,
  repliedAt: null,
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  preview: { subject: "s", text: "t" },
});

describe("buildPreviewRows", () => {
  it("recovers each contact's CSV row number by skipping rejected rows", () => {
    // file rows 2..6; rows 3 and 5 were rejected, so a,b,c are rows 2,4,6
    const errors: RowIssue[] = [{ row: 5, message: "x" }, { row: 3, message: "y" }];
    const rows = buildPreviewRows([contact("a"), contact("b"), contact("c")], errors, []);
    expect(rows.map((r) => [r.contact.id, r.row])).toEqual([["a", 2], ["b", 4], ["c", 6]]);
  });

  it("attaches cross-batch warnings and marks replied/bounced/opted-out ones as blocked", () => {
    const warnings: RowWarning[] = [
      { row: 2, message: "Email is already in another batch (status: replied)", existingStatus: "replied" },
      { row: 3, message: "Email is already in another batch (status: sent)", existingStatus: "sent" },
    ];
    const rows = buildPreviewRows([contact("a"), contact("b"), contact("c")], [], warnings);
    expect(rows.map((r) => [r.contact.id, r.warning?.existingStatus ?? null, r.blocked])).toEqual([
      ["a", "replied", true],
      ["b", "sent", false],
      ["c", null, false],
    ]);
  });
});

describe("selection", () => {
  const warnings: RowWarning[] = [
    { row: 2, message: "", existingStatus: "opted_out" },
    { row: 3, message: "", existingStatus: "scheduled" },
  ];
  const rows = buildPreviewRows([contact("a"), contact("b"), contact("c"), contact("d")], [], warnings);

  it("starts with every clean row selected; warned rows start unselected", () => {
    expect(initialSelection(rows)).toEqual(["c", "d"]);
  });

  it("toggle keeps table order and never selects a blocked row", () => {
    let s = initialSelection(rows);
    s = toggle(rows, s, "b");
    expect(s).toEqual(["b", "c", "d"]);
    s = toggle(rows, s, "c");
    expect(s).toEqual(["b", "d"]);
    expect(toggle(rows, s, "a")).toEqual(["b", "d"]);
  });

  it("select all picks every selectable row (blocked excluded); clear empties", () => {
    expect(setAll(rows, true)).toEqual(["b", "c", "d"]);
    expect(setAll(rows, false)).toEqual([]);
  });

  it("reports none / some / all against the selectable rows", () => {
    expect(selectionState(rows, [])).toBe("none");
    expect(selectionState(rows, ["c"])).toBe("some");
    expect(selectionState(rows, ["b", "c", "d"])).toBe("all");
  });
});
