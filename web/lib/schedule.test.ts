import { describe, expect, it } from "vitest";
import { parseLocalDateTime, planSchedule, toLocalInputValue } from "./schedule";

// Local wall-clock times (as an <input type="datetime-local"> yields them).
const now = new Date(2030, 0, 10, 8, 0); // 10 Jan 2030 08:00 local
const base = { selectedIds: ["a", "b", "c"], sendAt: "2030-01-11T09:00", staggerMinutes: "", overrides: {}, now };

describe("parseLocalDateTime", () => {
  it("parses datetime-local values as local time", () => {
    expect(parseLocalDateTime("2030-01-11T09:30")?.getTime()).toBe(new Date(2030, 0, 11, 9, 30).getTime());
  });
  it("rejects malformed and impossible values", () => {
    for (const v of ["", "tomorrow", "2030-02-30T09:00", "2030-01-11 09:00", "2030-01-11T25:00"]) {
      expect(parseLocalDateTime(v), v).toBeNull();
    }
  });
  it("round-trips with toLocalInputValue", () => {
    expect(toLocalInputValue(new Date(2030, 4, 6, 7, 8))).toBe("2030-05-06T07:08");
  });
});

describe("planSchedule", () => {
  it("accepts a future time and sends an ISO instant with timezone", () => {
    const r = planSchedule(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk).toEqual({ contactIds: ["a", "b", "c"], sendAt: new Date(2030, 0, 11, 9, 0).toISOString(), staggerMinutes: 0 });
    expect(r.plan.bulk!.sendAt).toMatch(/Z$/);
    expect(r.plan.overrides).toEqual([]);
  });

  it("rejects a past date", () => {
    const r = planSchedule({ ...base, sendAt: "2030-01-10T07:59" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.sendAt).toMatch(/future/i);
  });

  it("rejects the current minute (must be strictly in the future)", () => {
    const r = planSchedule({ ...base, sendAt: "2030-01-10T08:00" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing or malformed time", () => {
    expect(planSchedule({ ...base, sendAt: "" }).ok).toBe(false);
    expect(planSchedule({ ...base, sendAt: "nope" }).ok).toBe(false);
  });

  it("rejects more than 90 days ahead", () => {
    const r = planSchedule({ ...base, sendAt: "2030-04-11T09:00" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.sendAt).toMatch(/90 days/);
  });

  it("requires at least one selected contact", () => {
    const r = planSchedule({ ...base, selectedIds: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.form).toMatch(/select/i);
  });

  it("staggers contacts in table order", () => {
    const r = planSchedule({ ...base, staggerMinutes: "15" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk!.staggerMinutes).toBe(15);
    const t = (h: number, m: number) => new Date(2030, 0, 11, h, m).getTime();
    expect([r.plan.times.a!.getTime(), r.plan.times.b!.getTime(), r.plan.times.c!.getTime()]).toEqual([t(9, 0), t(9, 15), t(9, 30)]);
  });

  it("rejects an invalid stagger", () => {
    for (const s of ["-1", "2.5", "abc", "1441"]) {
      const r = planSchedule({ ...base, staggerMinutes: s });
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.errors.stagger).toBeTruthy();
    }
  });

  it("rejects a stagger that pushes the last send past 90 days", () => {
    const r = planSchedule({ ...base, sendAt: "2030-04-09T23:00", staggerMinutes: "1440" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.stagger).toMatch(/90 days/);
  });

  it("per-row override takes the row out of the bulk call and keeps the stagger for the rest", () => {
    const r = planSchedule({ ...base, staggerMinutes: "10", overrides: { b: "2030-01-12T10:00" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk!.contactIds).toEqual(["a", "c"]);
    expect(r.plan.overrides).toEqual([{ contactId: "b", sendAt: new Date(2030, 0, 12, 10, 0).toISOString() }]);
    expect(r.plan.times.c!.getTime()).toBe(new Date(2030, 0, 11, 9, 10).getTime());
    expect(r.plan.times.b!.getTime()).toBe(new Date(2030, 0, 12, 10, 0).getTime());
  });

  it("rejects a past per-row override and names the row", () => {
    const r = planSchedule({ ...base, overrides: { c: "2030-01-09T09:00" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.overrides.c).toMatch(/future/i);
    expect(r.errors.sendAt).toBeUndefined();
  });

  it("ignores overrides on unselected rows and needs no bulk time when every row is overridden", () => {
    const r = planSchedule({ ...base, selectedIds: ["a"], sendAt: "", overrides: { a: "2030-01-11T09:00", z: "garbage" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.bulk).toBeNull();
    expect(r.plan.overrides).toHaveLength(1);
  });

  it("treats an empty override as no override", () => {
    const r = planSchedule({ ...base, overrides: { a: "" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.bulk!.contactIds).toEqual(["a", "b", "c"]);
  });
});
