// Display helpers. Everything renders in the browser's local time zone.

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayPart = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const timePart = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

export function formatDay(v: string | Date): string {
  return dayPart.format(toDate(v));
}

export function formatTime(v: string | Date): string {
  return timePart.format(toDate(v));
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function percent(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`;
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Not scheduled",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Sent",
  replied: "Replied",
  bounced: "Bounced",
  opted_out: "Opted out",
  failed: "Failed",
  cancelled: "Cancelled",
  needs_review: "Needs review",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

const EVENT_LABEL: Record<string, string> = {
  imported: "Imported",
  batch_created: "Batch uploaded",
  scheduled: "Scheduled",
  rescheduled: "Rescheduled",
  message_cancelled: "Send cancelled",
  followup_enabled: "Follow-up on",
  followup_disabled: "Follow-up off",
  replied: "Reply received",
  opted_out: "Opted out",
  template_updated: "Follow-up template saved",
  sent: "Sent",
  failed: "Send failed",
  bounced: "Bounced",
  needs_review: "Needs review",
};

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/_/g, " ");
}
