import type { SendWindow } from "./types";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type SendWindowErrors = { start?: string; end?: string; tz?: string };

/** Client-side mirror of the server's checks (the server stays the authority, incl. the IANA zone name). */
export function validateSendWindow(w: SendWindow): SendWindowErrors {
  const errors: SendWindowErrors = {};
  if (!HHMM.test(w.start)) errors.start = "Use 24-hour HH:MM, e.g. 09:00.";
  if (!HHMM.test(w.end)) errors.end = "Use 24-hour HH:MM, e.g. 10:00.";
  if (!errors.start && !errors.end && w.end <= w.start) errors.end = "End must be after start (same day).";
  if (!w.tz.trim()) errors.tz = "Enter an IANA time zone, e.g. Asia/Kolkata.";
  return errors;
}

export const sendWindowLabel = (w: SendWindow) => `${w.start}–${w.end} ${w.tz}`;
