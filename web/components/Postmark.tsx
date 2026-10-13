import { formatDay, formatTime } from "@/lib/format";

/** A send time, set like a postmark: day on top, time below, in the data face. */
export function Postmark({ at, label }: { at: string | Date; label?: string }) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return <span className="muted">—</span>;
  return (
    <time className="postmark" dateTime={d.toISOString()} title={label}>
      <span className="postmark-day">{formatDay(d)}</span>
      <span className="postmark-time">{formatTime(d)}</span>
    </time>
  );
}
