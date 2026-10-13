"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { checkSendTime, planSchedule, toLocalInputValue, MAX_DAYS_AHEAD, MAX_STAGGER_MINUTES } from "@/lib/schedule";
import { buildPreviewRows, initialSelection, selectionState, setAll, toggle } from "@/lib/selection";
import { formatDateTime, localTimeZone, plural } from "@/lib/format";
import type { ContactStatus, Refusal, Resume, SendWindowInfo, UploadResult } from "@/lib/types";
import { sendWindowLabel } from "@/lib/sendWindow";
import { FollowupToggle } from "./FollowupToggle";
import { Postmark } from "./Postmark";
import { RefusalList } from "./RefusalList";
import { refusalText } from "@/lib/refusals";
import { StatusBadge } from "./StatusBadge";
import { CalendarClock, ChevronRight, Loader2, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmailLetter, IssueList } from "./EmailLetter";
import { Notice } from "./Notice";
import { Stepper } from "./Stepper";
import { TextButton } from "./TextButton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Props = { upload: UploadResult; resumes?: Resume[]; sendWindow?: SendWindowInfo | null; now?: () => Date };

type Outcome = {
  scheduled: number;
  failed: { contactId: string; email: string; message: string }[];
};

function SelectAll({ state, onChange }: { state: "none" | "some" | "all"; onChange: (checked: boolean) => void }) {
  return <Checkbox aria-label="Select all" checked={state === "all" ? true : state === "some" ? "indeterminate" : false} onCheckedChange={(v) => onChange(v === true)} />;
}

export function BatchScheduler({ upload, resumes = [], sendWindow = null, now = () => new Date() }: Props) {
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
  // A contact's own override outranks the picker (same precedence as the server).
  const attachmentName = (c: { attachment?: { displayName: string; source: string } | null }) =>
    c.attachment?.source === "contact" ? c.attachment.displayName : (resumeName ?? c.attachment?.displayName);

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

  const stepNow = outcome ? 4 : sendAt ? 3 : 2;

  return (
    <div>
      <Stepper current={stepNow} />
      <div className="space-y-5">
        {(upload.errors.length > 0 || upload.warnings.length > 0) && (
          <section className="space-y-3" aria-label="Import problems">
            {upload.errors.length > 0 && (
              <Notice tone="danger" title={`${plural(upload.errors.length, "row")} rejected and not imported`}>
                <IssueList>
                  {[...upload.errors]
                    .sort((a, b) => a.row - b.row)
                    .map((e) => (
                      <li key={`e${e.row}`}>
                        <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">Row {e.row}</span>
                        <span>{e.message}</span>
                      </li>
                    ))}
                </IssueList>
              </Notice>
            )}
            {upload.warnings.length > 0 && (
              <Notice tone="warning" title={`${plural(upload.warnings.length, "address", "addresses")} already in another batch — left unselected`}>
                <IssueList>
                  {rows
                    .filter((r) => r.warning)
                    .map((r) => (
                      <li key={`w${r.row}`}>
                        <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">Row {r.row}</span>
                        <span className="font-mono text-xs">{r.contact.email}</span>
                        <span>{r.warning!.message}</span>
                      </li>
                    ))}
                </IssueList>
              </Notice>
            )}
          </section>
        )}

        <section className="rounded-lg border bg-card" aria-labelledby="h-preview">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b px-4 py-3.5">
            <div className="space-y-0.5">
              <h2 id="h-preview" className="text-sm font-medium">
                Preview
              </h2>
              <p className="text-[13px] text-muted-foreground">Choose who to schedule, then set a send time below.</p>
            </div>
            <div className="w-full space-y-1.5 sm:w-64">
              {resumes.length > 0 ? (
                <>
                  <Label htmlFor="resume-pick">Resume to attach</Label>
                  <NativeSelect id="resume-pick" value={resumeId} onChange={(e) => setPickedResume(e.target.value)}>
                    {!resumeId && <option value="">Choose a resume</option>}
                    {resumes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName}
                        {r.isDefault ? " (default)" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                  <p className="text-xs text-muted-foreground">Sent as a PDF attachment with every selected email.</p>
                </>
              ) : (
                <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
                  <Paperclip aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    No resumes in the library. Add one in{" "}
                    <Link href="/settings" className="font-medium text-accent-text underline-offset-2 hover:underline">
                      Settings
                    </Link>
                    .
                  </span>
                </p>
              )}
            </div>
          </div>

          <Table className="md:min-w-[56rem]">
            <caption className="sr-only">Imported contacts. Choose who to schedule, then set a send time below.</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent max-md:flex max-md:items-center">
                <TableHead className="w-10 pl-4 max-md:flex max-md:w-auto max-md:items-center max-md:gap-2.5">
                  <SelectAll state={selState} onChange={(c) => setSelected(setAll(rows, c))} />
                  <span className="text-xs font-medium md:hidden" aria-hidden="true">
                    Select all
                  </span>
                </TableHead>
                <TableHead className="w-12 max-md:hidden">Row</TableHead>
                <TableHead className="max-md:hidden">Recipient</TableHead>
                <TableHead className="max-md:hidden">Subject</TableHead>
                <TableHead className="max-md:hidden">Status</TableHead>
                <TableHead className="max-md:hidden">Follow-up</TableHead>
                <TableHead className="pr-4 max-md:hidden">Send time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="max-md:block">
              {rows.map((r) => {
                const c = r.contact;
                const isSel = selected.includes(c.id);
                const st = status[c.id] ?? c.status;
                const isOpen = open.has(c.id);
                const own = ownTime.has(c.id);
                const ownErr = errs?.overrides[c.id];
                return (
                  <Fragment key={c.id}>
                    <TableRow data-state={isSel ? "selected" : undefined} className={cn("relative align-top max-md:block max-md:py-3 max-md:pl-10", isOpen && "border-b-0")}>
                      <TableCell className="pl-4 max-md:absolute max-md:top-3.5 max-md:left-0 max-md:p-0 max-md:pl-4">
                        <Checkbox
                          aria-label={`Select ${c.email}`}
                          checked={isSel}
                          disabled={r.blocked || st !== "uploaded"}
                          onCheckedChange={() => setSelected((s) => toggle(rows, s, c.id))}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground max-md:hidden">{r.row}</TableCell>
                      <TableCell className="max-w-64 max-md:block max-md:max-w-none max-md:px-4 max-md:py-1">
                        <div className="truncate font-medium">{c.person}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{c.email}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.company} · {c.role}
                        </div>
                        {r.warning && (
                          <span className={cn("mt-1 inline-block rounded-md px-1.5 py-0.5 text-[11px] font-medium", r.blocked ? "bg-st-red-bg text-st-red" : "bg-st-amber-bg text-st-amber")}>
                            {r.blocked ? "Blocked: " : "Also in "}another batch
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-72 max-md:block max-md:max-w-none max-md:px-4 max-md:py-1">
                        <div className="truncate">{c.preview.subject}</div>
                        {attachmentName(c) && (
                          <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                            <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                            <span className="truncate">Attachment: {attachmentName(c)}</span>
                          </div>
                        )}
                        <TextButton
                          className="mt-1 inline-flex items-center gap-0.5"
                          aria-expanded={isOpen}
                          aria-controls={`pv-${c.id}`}
                          aria-label={`${isOpen ? "Hide" : "Preview"} email to ${c.email}`}
                          onClick={() => setOpen((s) => flip(s, c.id))}
                        >
                          <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
                          {isOpen ? "Hide email" : "Preview email"}
                        </TextButton>
                      </TableCell>
                      <TableCell className="max-md:block max-md:px-4 max-md:py-1">
                        <StatusBadge status={st} />
                      </TableCell>
                      <TableCell className="max-md:block max-md:px-4 max-md:py-1">
                        <FollowupToggle contact={c} disabled={r.blocked} />
                      </TableCell>
                      <TableCell className="pr-4 max-md:block max-md:px-4 max-md:py-1">
                        {scheduledAt[c.id] ? (
                          <Postmark at={scheduledAt[c.id]!} label="Scheduled" />
                        ) : own ? (
                          <div className="w-44 space-y-1">
                            <label className="sr-only" htmlFor={`own-${c.id}`}>
                              Send time for {c.email}
                            </label>
                            <Input
                              id={`own-${c.id}`}
                              type="datetime-local"
                              value={overrides[c.id] ?? ""}
                              min={minLocal}
                              max={maxLocal}
                              onChange={(e) => setOverrides((o) => ({ ...o, [c.id]: e.target.value }))}
                              aria-invalid={ownErr ? true : undefined}
                              aria-describedby={ownErr ? `own-err-${c.id}` : undefined}
                              className="h-7 px-2 text-xs"
                            />
                            {ownErr && isSel && overrides[c.id] && (
                              <p className="text-xs text-destructive" id={`own-err-${c.id}`}>
                                {ownErr}
                              </p>
                            )}
                            <TextButton onClick={() => clearOwnTime(c.id)}>Use batch time</TextButton>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {isSel && times[c.id] ? <Postmark at={times[c.id]!} label="Planned" /> : <span className="text-muted-foreground">—</span>}
                            {st === "uploaded" && !r.blocked && (
                              <div>
                                <TextButton aria-label={`Set own time for ${c.email}`} onClick={() => setOwnTime((s) => flip(s, c.id))}>
                                  Set own time
                                </TextButton>
                              </div>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30 max-md:block" id={`pv-${c.id}`}>
                        <TableCell colSpan={7} className="px-4 pt-0 pb-4 max-md:block max-md:pt-3">
                          <EmailLetter label={`Email to ${c.email}`} to={c.email} subject={c.preview.subject} attachment={attachmentName(c)} body={c.preview.text} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </section>

        {refused && <RefusalList refused={refused} onDeselect={() => setSelected((s) => s.filter((id) => !refused.some((r) => r.contactId === id)))} />}
        {error && <Notice tone="danger">{error}</Notice>}
        {outcome && (
          <Notice tone={outcome.failed.length ? "warning" : "success"} role="status" title={`Scheduled ${plural(outcome.scheduled, "email")}.`}>
            {outcome.failed.length > 0 && (
              <IssueList>
                {outcome.failed.map((f) => (
                  <li key={f.contactId}>
                    <span className="font-mono text-xs">{f.email}</span>
                    <span>Own time not scheduled: {f.message}</span>
                  </li>
                ))}
              </IssueList>
            )}
            <p>
              Track them in{" "}
              <Link href={`/contacts?batchId=${encodeURIComponent(upload.batch.id)}`} className="font-medium underline underline-offset-2">
                Contacts
              </Link>
              .
            </p>
          </Notice>
        )}

        <section className="rounded-lg border bg-card p-4" aria-label="Schedule">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
            <div className="space-y-1.5">
              <Label htmlFor="send-at">Send at</Label>
              <Input
                id="send-at"
                type="datetime-local"
                value={sendAt}
                min={minLocal}
                max={maxLocal}
                onChange={(e) => setSendAt(e.target.value)}
                aria-invalid={sendAtError ? true : undefined}
                aria-describedby="send-at-hint"
              />
              <p className="text-xs text-muted-foreground" id="send-at-hint">
                {sendAtError ? <span className="text-destructive">{sendAtError}</span> : `Your time (${localTimeZone()}), up to ${MAX_DAYS_AHEAD} days ahead`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="stagger">Stagger (minutes)</Label>
              <Input
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
              <p className="text-xs text-muted-foreground" id="stagger-hint">
                {errs?.stagger ? <span className="text-destructive">{errs.stagger}</span> : "Gap between emails, in table order"}
              </p>
            </div>
          </div>
          {sendWindow?.enforced && (
            <p className="mt-4 text-[13px] text-muted-foreground">
              Emails send in the next daily window ({sendWindowLabel(sendWindow.window)}) after the time you choose.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-[13px] text-muted-foreground" aria-live="polite">
              {n === 0
                ? "Select at least one contact"
                : plan.ok && plan.plan.bulk
                  ? `${plural(n, "email")} · first ${formatDateTime(plan.plan.bulk.sendAt)}`
                  : plural(n, "email") + " selected"}
            </p>
            <Button disabled={!canConfirm} onClick={onConfirm}>
              {busy ? <Loader2 className="animate-spin" /> : <CalendarClock />}
              {busy ? "Scheduling…" : `Schedule ${plural(n, "email")}`}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
