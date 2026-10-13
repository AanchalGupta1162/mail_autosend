import { refusalText } from "@/lib/refusals";
import type { Refusal } from "@/lib/types";
import { plural } from "@/lib/format";
import { IssueList } from "./EmailLetter";
import { Notice } from "./Notice";
import { Button } from "@/components/ui/button";

/** Bulk scheduling is all-or-nothing: shows every refused contact and why. */
export function RefusalList({ refused, onDeselect }: { refused: Refusal[]; onDeselect?: () => void }) {
  return (
    <Notice tone="danger" role="alert" title={`Nothing was scheduled. ${plural(refused.length, "contact")} can't be sent:`}>
      <IssueList>
        {refused.map((r) => (
          <li key={r.contactId}>
            <span className="font-mono text-xs">{r.email ?? "Unknown contact"}</span>
            <span>{refusalText(r.reason)}</span>
          </li>
        ))}
      </IssueList>
      {onDeselect && (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onDeselect}>
          Deselect these contacts
        </Button>
      )}
    </Notice>
  );
}
