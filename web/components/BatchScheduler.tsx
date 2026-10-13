"use client";

import { Fragment, useMemo, useRef, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { checkSendTime, planSchedule, toLocalInputValue, MAX_DAYS_AHEAD, MAX_STAGGER_MINUTES } from "@/lib/schedule";
import { buildPreviewRows, initialSelection, selectionState, setAll, toggle } from "@/lib/selection";
import { formatDateTime, localTimeZone, plural } from "@/lib/format";
import type { ContactStatus, Refusal, Resume, UploadResult } from "@/lib/types";
import { FollowupToggle } from "./FollowupToggle";
import { Postmark } from "./Postmark";
import { RefusalList } from "./RefusalList";
import { refusalText } from "@/lib/refusals";
import { StatusBadge } from "./StatusBadge";

type Props = { upload: UploadResult; resumes?: Resume[]; now?: () => Date };

type Outcome = {
  scheduled: number;
  failed: { contactId: string; email: string; message: string }[];
};

function SelectAll({ state, onChange }: { state: "none" | "some" | "all"; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label="Select all" checked={state === "all"} onChange={(e) => onChange(e.target.checked)} />;
}

export function BatchScheduler({ upload, resumes = [], now = () => new Date() }: Props) {
  const rows = useMemo(() => buildPreviewRows(upload.contacts, upload.warnings), [upload]);
  const [selected, setSelected] = useState<string[]>(() => initialSelection(rows));
  const [sendAt, setSendAt] = useState("");
  const [stagger, setStagger] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [ownTime, setOwnTime] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, ContactStatus>>({});
  const [scheduledAt, setScheduledAt] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Refusal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  // Until the operator chooses, the library default (if any) applies.
  const [pickedResume, setPickedResume] = useState<string | null>(null);
  const resumeId = pickedResume ?? resumes.find((r) => r.isDefault)?.id ?? "";
  const resumeName = resumes.find((r) => r.id === resumeId)?.displayName;

  const plan = planSchedule({ selectedIds: selected, sendAt, staggerMinutes: stagger, overrides, now: now() });
  const errs = plan.ok ? null : plan.errors;
  // The bulk time is checked as soon as it is typed, even before any row is selected.
  const sendAtError = sendAt ? (checkSendTime(sendAt, now()).error ?? errs?.sendAt) : undefined;
  const times = plan.ok ? plan.plan.times : {};
  const selState = selectionState(rows, selected);
  const minLocal = toLocalInputValue(new Date(now().getTime() + 60_000));
  const maxLocal = toLocalInputValue(new Date(now().getTime() + MAX_DAYS_AHEAD * 86_400_000));
  const emailOf = (id: string) => rows.find((r) => r.contact.id === id)?.contact.email ?? id;

  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  function clearOwnTime(id: string) {
    setOwnTime((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    setOverrides((o) => {
      const rest = { ...o };
      delete rest[id];
      return rest;
    });
  }

  async function onConfirm() {
    if (!plan.ok) return;
    setBusy(true);
    setRefused(null);
    setError(null);
    setOutcome(null);
    const done: Record<string, string> = {};
    const failed: Outcome["failed"] = [];
    try {
      if (plan.plan.bulk) {
        const messages = await api.scheduleBatch(upload.batch.id, resumeId ? { ...plan.plan.bulk, resumeId } : plan.plan.bulk);
        for (const m of messages ?? []) done[m.contactId] = m.scheduledFor;
        if (!messages?.length) for (const id of plan.plan.bulk.contactIds) done[id] = plan.plan.times[id]!.toISOString();
      }
    } catch (err) {
      if (err instanceof ApiError && err.refused?.length) setRefused(err.refused);
      else setError(err instanceof ApiError ? err.message : "Scheduling failed. Nothing was scheduled.");
      setBusy(false);
      return;
    }
    for (const o of plan.plan.overrides) {
      try {
        const m = await api.scheduleContact(o.contactId, o.sendAt, resumeId || undefined);
        done[o.contactId] = m?.scheduledFor ?? o.sendAt;
      } catch (err) {
        const reason = err instanceof ApiError && err.refused?.[0] ? err.refused[0].reason : null;
        failed.push({ contactId: o.contactId, email: emailOf(o.contactId), message: reason ? refusalText(reason) : err instanceof Error ? err.message : "Failed" });
      }
    }
    const ids = Object.keys(done);
    setScheduledAt((s) => ({ ...s, ...done }));
    setStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, "scheduled" as const])) }));
    setSelected((s) => s.filter((id) => !done[id]));
    setOutcome({ scheduled: ids.length, failed });
    setBusy(false);
  }

  const n = selected.length;
  const canConfirm = plan.ok && !busy;

  return (
    <div className="scheduler">
      {(upload.errors.length > 0 || upload.warnings.length > 0) && (
        <section className="issues" aria-label="Import problems">
          {upload.errors.length > 0 && (
            <div className="callout callout-danger">
              <p className="callout-title">{plural(upload.errors.length, "row")} rejected and not imported</p>
              <ul className="issue-list">
                {[...upload.errors].sort((a, b) => a.row - b.row).map((e) => (
                  <li key={`e${e.row}`}>
                    <span className="mono issue-row">Row {e.row}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {upload.warnings.length > 0 && (
            <div className="callout callout-warning">
              <p className="callout-title">{plural(upload.warnings.length, "address", "addresses")} already in another batch — left unselected</p>
              <ul className="issue-list">
                {rows
                  .filter((r) => r.warning)
                  .map((r) => (
                    <li key={`w${r.row}`}>
                      <span className="mono issue-row">Row {r.row}</span>
                      <span className="mono">{r.contact.email}</span>
                      <span>{r.warning!.message}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <div className="table-wrap">
        <table className="table preview-table">
          <caption className="sr-only">Imported contacts. Choose who to schedule, then set a send time below.</caption>
          <thead>
            <tr>
              <th scope="col" className="col-check">
                <SelectAll state={selState} onChange={(c) => setSelected(setAll(rows, c))} />
              </th>
              <th scope="col" className="col-row">Row</th>
              <th scope="col">Recipient</th>
              <th scope="col">Subject</th>
              <th scope="col">Status</th>
              <th scope="col">Follow-up</th>
              <th scope="col">Send time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = r.contact;
              const isSel = selected.includes(c.id);
              const st = status[c.id] ?? c.status;
              const isOpen = open.has(c.id);
              const own = ownTime.has(c.id);
              const ownErr = errs?.overrides[c.id];
              return (
                <Fragment key={c.id}>
                  <tr className={isSel ? "is-selected" : undefined}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.email}`}
                        checked={isSel}
                        disabled={r.blocked || st !== "uploaded"}
                        onChange={() => setSelected((s) => toggle(rows, s, c.id))}
                      />
                    </td>
                    <td className="col-row mono">{r.row}</td>
                    <td>
                      <div className="cell-primary">{c.person}</div>
                      <div className="cell-secondary mono">{c.email}</div>
                      <div className="cell-secondary">
                        {c.company} · {c.role}
                      </div>
                      {r.warning && <span className={`tag ${r.blocked ? "tag-danger" : "tag-warning"}`}>{r.blocked ? "Blocked: " : "Also in "}another batch</span>}
                    </td>
                    <td>
                      <div className="cell-subject">{c.preview.subject}</div>
                      {(resumeName ?? c.attachment?.displayName) && <div className="cell-secondary attachment-line">Attachment: {resumeName ?? c.attachment?.displayName}</div>}
                      <button
                        type="button"
                        className="btn-link"
                        aria-expanded={isOpen}
                        aria-controls={`pv-${c.id}`}
                        aria-label={`${isOpen ? "Hide" : "Preview"} email to ${c.email}`}
                        onClick={() => setOpen((s) => flip(s, c.id))}
                      >
                        {isOpen ? "Hide email" : "Preview email"}
                      </button>
                    </td>
                    <td>
                      <StatusBadge status={st} />
                    </td>
                    <td>
                      <FollowupToggle contact={c} disabled={r.blocked} />
                    </td>
                    <td className="col-time">
                      {scheduledAt[c.id] ? (
                        <Postmark at={scheduledAt[c.id]!} label="Scheduled" />
                      ) : own ? (
                        <div className="own-time">
                          <label className="sr-only" htmlFor={`own-${c.id}`}>
                            Send time for {c.email}
                          </label>
                          <input
                            id={`own-${c.id}`}
                            type="datetime-local"
                            value={overrides[c.id] ?? ""}
                            min={minLocal}
                            max={maxLocal}
                            onChange={(e) => setOverrides((o) => ({ ...o, [c.id]: e.target.value }))}
                            aria-invalid={ownErr ? true : undefined}
                            aria-describedby={ownErr ? `own-err-${c.id}` : undefined}
                          />
                          {ownErr && isSel && overrides[c.id] && (
                            <p className="field-error" id={`own-err-${c.id}`}>
                              {ownErr}
                            </p>
                          )}
                          <button type="button" className="btn-link" onClick={() => clearOwnTime(c.id)}>
                            Use batch time
                          </button>
                        </div>
                      ) : (
                        <div className="planned">
                          {isSel && times[c.id] ? <Postmark at={times[c.id]!} label="Planned" /> : <span className="muted">—</span>}
                          {st === "uploaded" && !r.blocked && (
                            <button type="button" className="btn-link" aria-label={`Set own time for ${c.email}`} onClick={() => setOwnTime((s) => flip(s, c.id))}>
                              Set own time
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="preview-row" id={`pv-${c.id}`}>
                      <td colSpan={7}>
                        <article className="letter" aria-label={`Email to ${c.email}`}>
                          <dl className="letter-head">
                            <div>
                              <dt>To</dt>
                              <dd className="mono">{c.email}</dd>
                            </div>
                            <div>
                              <dt>Subject</dt>
                              <dd>{c.preview.subject}</dd>
                            </div>
                            {(resumeName ?? c.attachment?.displayName) && (
                              <div>
                                <dt>Attachment</dt>
                                <dd>{resumeName ?? c.attachment?.displayName}</dd>
                              </div>
                            )}
                          </dl>
                          {/* Plain text only: the API never sends HTML, and we never inject markup. */}
                          <pre className="letter-body">{c.preview.text}</pre>
                        </article>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {refused && <RefusalList refused={refused} onDeselect={() => setSelected((s) => s.filter((id) => !refused.some((r) => r.contactId === id)))} />}
      {error && <p className="callout callout-danger">{error}</p>}
      {outcome && (
        <div className={`callout ${outcome.failed.length ? "callout-warning" : "callout-success"}`} role="status">
          <p className="callout-title">Scheduled {plural(outcome.scheduled, "email")}.</p>
          {outcome.failed.length > 0 && (
            <ul className="issue-list">
              {outcome.failed.map((f) => (
                <li key={f.contactId}>
                  <span className="mono">{f.email}</span>
                  <span>Own time not scheduled: {f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p>
            Track them in <Link href={`/contacts?batchId=${encodeURIComponent(upload.batch.id)}`}>Contacts</Link>.
          </p>
        </div>
      )}

      <section className="schedule-bar" aria-label="Schedule">
        <div className="field">
          <label htmlFor="send-at">Send at</label>
          <input
            id="send-at"
            type="datetime-local"
            value={sendAt}
            min={minLocal}
            max={maxLocal}
            onChange={(e) => setSendAt(e.target.value)}
            aria-invalid={sendAtError ? true : undefined}
            aria-describedby="send-at-hint"
          />
          <p className="hint" id="send-at-hint">
            {sendAtError ? <span className="field-error-inline">{sendAtError}</span> : `Your time (${localTimeZone()}), up to ${MAX_DAYS_AHEAD} days ahead`}
          </p>
        </div>
        <div className="field field-narrow">
          <label htmlFor="stagger">Stagger (minutes)</label>
          <input
            id="stagger"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_STAGGER_MINUTES}
            placeholder="0"
            value={stagger}
            onChange={(e) => setStagger(e.target.value)}
            aria-invalid={errs?.stagger ? true : undefined}
            aria-describedby="stagger-hint"
          />
          <p className="hint" id="stagger-hint">
            {errs?.stagger ? <span className="field-error-inline">{errs.stagger}</span> : "Gap between emails, in table order"}
          </p>
        </div>
        <div className="field">
          {resumes.length > 0 ? (
            <>
              <label htmlFor="resume-pick">Resume to attach</label>
              <select id="resume-pick" className="resume-pick" value={resumeId} onChange={(e) => setPickedResume(e.target.value)}>
                {!resumeId && <option value="">Choose a resume</option>}
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                    {r.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <p className="hint">Sent as a PDF attachment with every selected email.</p>
            </>
          ) : (
            <p className="hint">
              No resumes in the library. Add one in <Link href="/settings">Settings</Link>.
            </p>
          )}
        </div>
        <div className="schedule-summary">
          <p className="hint" aria-live="polite">
            {n === 0
              ? "Select at least one contact"
              : plan.ok && plan.plan.bulk
                ? `${plural(n, "email")} · first ${formatDateTime(plan.plan.bulk.sendAt)}`
                : plural(n, "email") + " selected"}
          </p>
          <button type="button" className="btn btn-primary" disabled={!canConfirm} onClick={onConfirm}>
            {busy ? "Scheduling…" : `Schedule ${plural(n, "email")}`}
          </button>
        </div>
      </section>
    </div>
  );
}
