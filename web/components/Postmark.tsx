import { formatDay, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A send time: day over time, in tabular figures. */
export function Postmark({ at, label, className }: { at: string | Date; label?: string; className?: string }) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return <span className="text-muted-foreground">—</span>;
  return (
    <time className={cn("inline-flex flex-col leading-tight tabular-nums", className)} dateTime={d.toISOString()} title={label}>
      <span className="text-[13px] font-medium">{formatDay(d)}</span>
      <span className="font-mono text-xs text-muted-foreground">{formatTime(d)}</span>
    </time>
  );
}
