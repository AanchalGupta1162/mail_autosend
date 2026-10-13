import { z } from "zod";

// Daily window in which REAL sends may be claimed (when SEND_WINDOW_ENFORCED). Stored in the settings
// table under `send_window`; the default applies while the row is absent or unreadable.
export const SEND_WINDOW_KEY = "send_window";
export const DEFAULT_SEND_WINDOW = Object.freeze({ start: "09:00", end: "10:00", tz: "Asia/Kolkata" });

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const validTz = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// start must be strictly before end on the same local day (no overnight windows).
export const sendWindowSchema = z
  .strictObject({
    start: z.string().regex(HHMM, "start must be HH:MM (24 h)"),
    end: z.string().regex(HHMM, "end must be HH:MM (24 h)"),
    tz: z.string().min(1).max(64).refine(validTz, "tz must be an IANA time zone, e.g. Asia/Kolkata"),
  })
  .refine((w) => minutesOf(w.start) < minutesOf(w.end), { message: "start must be before end", path: ["end"] });

// Local wall-clock minutes since midnight in `tz` (DST-aware through Intl).
function localMinutes(tz, now) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get("hour") % 24) * 60 + get("minute");
}

// start inclusive, end exclusive; seconds are ignored (minute granularity), so 09:59:59 is inside and 10:00:00 is not.
export function isInSendWindow(window, now = new Date()) {
  const m = localMinutes(window.tz, now);
  return m >= minutesOf(window.start) && m < minutesOf(window.end);
}

export const windowLabel = (w) => `${w.start}–${w.end} ${w.tz}`;

export async function getSendWindow(db) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [SEND_WINDOW_KEY]);
  const parsed = sendWindowSchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : { ...DEFAULT_SEND_WINDOW };
}

export async function putSendWindow(db, window) {
  await db.query(
    `INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SEND_WINDOW_KEY, JSON.stringify(window)],
  );
  await db.query("INSERT INTO events(type, meta) VALUES ('send_window_updated', $1::jsonb)", [JSON.stringify(window)]);
  return window;
}
