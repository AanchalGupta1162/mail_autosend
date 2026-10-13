import { statusLabel } from "@/lib/format";

/** Contact status or message state as a small labelled badge (colour is never the only cue). */
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{statusLabel(status)}</span>;
}
