import { refusalText } from "@/lib/refusals";
import type { Refusal } from "@/lib/types";
import { plural } from "@/lib/format";

/** Bulk scheduling is all-or-nothing: shows every refused contact and why. */
export function RefusalList({ refused, onDeselect }: { refused: Refusal[]; onDeselect?: () => void }) {
  return (
    <div className="callout callout-danger" role="alert">
      <p className="callout-title">
        Nothing was scheduled. {plural(refused.length, "contact")} can&apos;t be sent:
      </p>
      <ul className="refusals">
        {refused.map((r) => (
          <li key={r.contactId}>
            <span className="mono">{r.email ?? "Unknown contact"}</span>
            <span className="refusal-reason">{refusalText(r.reason)}</span>
          </li>
        ))}
      </ul>
      {onDeselect && (
        <button type="button" className="btn btn-quiet" onClick={onDeselect}>
          Deselect these contacts
        </button>
      )}
    </div>
  );
}
