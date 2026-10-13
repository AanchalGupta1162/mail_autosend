import { Notice } from "./Notice";
import { formatDateTime } from "@/lib/format";
import type { Dashboard } from "@/lib/types";

/** Two different situations: one message waiting on its resume, or all real sending paused. */
export function SendHoldBanner({ hold }: { hold: NonNullable<Dashboard["sendHold"]> }) {
  if (hold.scope === "resume") {
    return (
      <Notice tone="warning" role="alert">
        <p>A message is on hold since {formatDateTime(hold.at)}: its resume is missing or could not be read ({hold.code}). Other emails keep sending. The held message is retried about every 15 minutes; fix or re-select the resume in Settings, or reschedule it.</p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" role="alert">
      <p>Sending paused since {formatDateTime(hold.at)}: credentials or configuration error ({hold.code}). Check the Gmail app password and the signature and resume files. Real sending is paused and retried about every 15 minutes; the warning clears after the next successful send.</p>
    </Notice>
  );
}
