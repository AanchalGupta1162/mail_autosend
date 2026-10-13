"use client";

import { useId, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { refusalText } from "@/lib/refusals";
import type { Contact, FollowupResult } from "@/lib/types";

const MIN = 1;
const MAX = 60;

type Props = {
  contact: Pick<Contact, "id" | "email" | "followupRequested" | "followupDelayDays">;
  onChange?: (result: FollowupResult) => void;
  disabled?: boolean;
};

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const r = err.refused?.[0];
    if (r) return refusalText(r.reason);
    return err.message;
  }
  return "Could not update the follow-up";
}

/**
 * Follow-up checkbox + delay. Saves immediately via PUT /api/contacts/:id/followup.
 * Parents pass a `key` derived from the contact's follow-up fields to resync after reloads.
 */
export function FollowupToggle({ contact, onChange, disabled }: Props) {
  const id = useId();
  const [enabled, setEnabled] = useState(contact.followupRequested);
  const [delay, setDelay] = useState(String(contact.followupDelayDays));
  const [savedDelay, setSavedDelay] = useState(contact.followupDelayDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseDelay = (): number | null => {
    const n = Number(delay);
    return /^\d+$/.test(delay.trim()) && n >= MIN && n <= MAX ? n : null;
  };

  async function save(next: boolean, delayDays: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setFollowup(contact.id, { enabled: next, delayDays });
      setEnabled(result.contact.followupRequested);
      setSavedDelay(result.contact.followupDelayDays);
      setDelay(String(result.contact.followupDelayDays));
      onChange?.(result);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function onToggle() {
    const d = parseDelay();
    if (d === null) return setError(`Delay must be ${MIN}–${MAX} days`);
    void save(!enabled, d);
  }

  function onDelayCommit() {
    const d = parseDelay();
    if (d === null) return setError(`Delay must be ${MIN}–${MAX} days`);
    setError(null);
    if (enabled && d !== savedDelay) void save(true, d);
  }

  return (
    <div className="followup">
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled || busy}
          onChange={onToggle}
          aria-label={`Follow up with ${contact.email}`}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <span aria-hidden="true">Follow up</span>
      </label>
      <label className="followup-delay">
        <span className="sr-only">Days after the first email for {contact.email}</span>
        <input
          type="number"
          inputMode="numeric"
          min={MIN}
          max={MAX}
          value={delay}
          disabled={disabled || busy}
          onChange={(e) => setDelay(e.target.value)}
          onBlur={onDelayCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onDelayCommit();
            }
          }}
        />
        <span aria-hidden="true">days after</span>
      </label>
      {error && (
        <p className="field-error" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}
