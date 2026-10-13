// Client-side schedule validation. Mirrors src/domain/schedule.js (future, <= 90 days,
// stagger 0..1440 min, every staggered time within 90 days). The server stays the authority.

export const MAX_DAYS_AHEAD = 90;
export const MAX_STAGGER_MINUTES = 24 * 60;
const DAY_MS = 86_400_000;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Parses an <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm") as local wall-clock time. */
export function parseLocalDateTime(value: string): Date | null {
  const m = LOCAL_RE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ScheduleInput {
  /** Selected contact ids, in table order (stagger follows this order). */
  selectedIds: string[];
  /** Bulk send time (datetime-local value). */
  sendAt: string;
  /** Minutes between consecutive bulk sends; empty means 0. */
  staggerMinutes: string;
  /** Per-row send time (datetime-local value); empty/missing means "use the bulk time". */
  overrides: Record<string, string>;
  now: Date;
}

export interface SchedulePlan {
  bulk: { contactIds: string[]; sendAt: string; staggerMinutes: number } | null;
  overrides: { contactId: string; sendAt: string }[];
  /** Planned send time per selected contact. */
  times: Record<string, Date>;
}

export interface ScheduleErrors {
  form?: string;
  sendAt?: string;
  stagger?: string;
  overrides: Record<string, string>;
}

export type ScheduleResult = { ok: true; plan: SchedulePlan } | { ok: false; errors: ScheduleErrors };

/** Validates one datetime-local value against the server's rules. */
export function checkSendTime(value: string, now: Date): { at?: Date; error?: string } {
  if (!value) return { error: "Choose a date and time" };
  const at = parseLocalDateTime(value);
  if (!at) return { error: "Enter a valid date and time" };
  if (at.getTime() <= now.getTime()) return { error: "Send time must be in the future" };
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) return { error: `Send time must be within ${MAX_DAYS_AHEAD} days` };
  return { at };
}

export function planSchedule(input: ScheduleInput): ScheduleResult {
  const { selectedIds, now } = input;
  const errors: ScheduleErrors = { overrides: {} };
  const times: Record<string, Date> = {};

  if (selectedIds.length === 0) errors.form = "Select at least one contact to schedule";

  const own = selectedIds.filter((id) => (input.overrides[id] ?? "") !== "");
  const bulkIds = selectedIds.filter((id) => !own.includes(id));

  const overrides: SchedulePlan["overrides"] = [];
  for (const id of own) {
    const r = checkSendTime(input.overrides[id]!, now);
    if (r.error) errors.overrides[id] = r.error;
    else {
      times[id] = r.at!;
      overrides.push({ contactId: id, sendAt: r.at!.toISOString() });
    }
  }

  let stagger = 0;
  const rawStagger = input.staggerMinutes.trim();
  if (rawStagger !== "") {
    stagger = Number(rawStagger);
    if (!/^\d+$/.test(rawStagger) || stagger > MAX_STAGGER_MINUTES) {
      errors.stagger = `Stagger must be a whole number of minutes from 0 to ${MAX_STAGGER_MINUTES}`;
    }
  }

  let bulk: SchedulePlan["bulk"] = null;
  if (bulkIds.length > 0) {
    const r = checkSendTime(input.sendAt, now);
    if (r.error) errors.sendAt = r.error;
    else if (!errors.stagger) {
      const start = r.at!;
      bulkIds.forEach((id, i) => {
        times[id] = new Date(start.getTime() + i * stagger * 60_000);
      });
      const last = times[bulkIds.at(-1)!]!;
      if (last.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) {
        errors.stagger = `With this stagger the last email would go out after ${MAX_DAYS_AHEAD} days`;
      } else {
        bulk = { contactIds: bulkIds, sendAt: start.toISOString(), staggerMinutes: stagger };
      }
    }
  }

  const failed = errors.form || errors.sendAt || errors.stagger || Object.keys(errors.overrides).length > 0;
  if (failed) return { ok: false, errors };
  return { ok: true, plan: { bulk, overrides, times } };
}
