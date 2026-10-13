import { statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tone = "green" | "indigo" | "violet" | "red" | "amber" | "neutral";

const TONE: Record<Tone, string> = {
  green: "bg-st-green-bg text-st-green",
  indigo: "bg-st-indigo-bg text-st-indigo",
  violet: "bg-st-violet-bg text-st-violet",
  red: "bg-st-red-bg text-st-red",
  amber: "bg-st-amber-bg text-st-amber",
  neutral: "bg-st-neutral-bg text-st-neutral",
};

const STATUS_TONE: Record<string, Tone> = {
  sent: "green",
  scheduled: "indigo",
  sending: "indigo",
  replied: "violet",
  failed: "red",
  bounced: "red",
  needs_review: "amber",
  opted_out: "neutral",
  cancelled: "neutral",
  uploaded: "neutral",
};

export const statusTone = (status: string): Tone => STATUS_TONE[status] ?? "neutral";

/** Contact status or message state as a small labelled badge (colour is never the only cue). */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      data-status={status}
      className={cn("inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none font-medium whitespace-nowrap", TONE[statusTone(status)], className)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {statusLabel(status)}
    </span>
  );
}
