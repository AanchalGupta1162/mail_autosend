"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, MoreHorizontal, Paperclip, Search, TriangleAlert, Users } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { checkSendTime, toLocalInputValue, MAX_DAYS_AHEAD } from "@/lib/schedule";
import { formatDateTime, plural, statusLabel } from "@/lib/format";
import { refusalText } from "@/lib/refusals";
import { CONTACT_STATUSES, type BatchSummary, type ContactListItem, type ContactStatus, type ContactsPage, type MessageRef, type ResolveAction, type Resume } from "@/lib/types";
import { useMode } from "./AppShell";
import { FollowupToggle } from "./FollowupToggle";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Postmark } from "./Postmark";
import { StatusBadge } from "./StatusBadge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 25;

const isStatus = (v: string | undefined): v is ContactStatus => !!v && (CONTACT_STATUSES as readonly string[]).includes(v);

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.refused?.[0] ? refusalText(err.refused[0].reason) : err.message;
  return "Something went wrong. Try again.";
}

type Confirm = "opt-out" | "replied" | null;

const RESOLVE_COPY: Record<ResolveAction, { label: string; ask: string; confirm: string; hint: string }> = {
  mark_sent: { label: "It was sent", ask: "Check your Sent folder first. Record this email as delivered?", confirm: "Mark sent", hint: "It reached the recipient. Record it as delivered." },
  requeue: { label: "Send again", ask: "Send it again now? If it did go out, the recipient gets a duplicate.", confirm: "Send again", hint: "It did not go out. Queue it again now." },
  cancel: { label: "Drop it", ask: "Drop this email? It will not be sent.", confirm: "Drop email", hint: "Do not send it at all." },
};

const kindLabel = (m: Pick<MessageRef, "kind">) => (m.kind === "followup" ? "Follow-up" : "First email");

function RowActions({ contact, onDone }: { contact: ContactListItem; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [resolveMsg, setResolveMsg] = useState<MessageRef | null>(null);
  const [resolving, setResolving] = useState<ResolveAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hide a cancelled send at once, before the list reload replaces this row's data.
  const [cancelled, setCancelled] = useState<string[]>([]);

  const initial = contact.messages.find((m) => m.kind === "initial");
  const pending = contact.messages.filter((m) => m.state === "scheduled" && !cancelled.includes(m.id));
  const canSchedule = (contact.status === "uploaded" || contact.status === "scheduled") && (!initial || initial.state === "scheduled");
  const review = contact.messages.filter((m) => m.state === "needs_review");
  const closed = contact.status === "replied" || contact.status === "opted_out";
  const hasMenu = canSchedule || pending.length > 0 || !closed || contact.status !== "opted_out";

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      setConfirm(null);
      setResolveMsg(null);
      setResolving(null);
      if (done) toast.success(done);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const r = checkSendTime(when, new Date());
    if (r.error) return setError(r.error);
    void run(() => api.scheduleContact(contact.id, r.at!.toISOString()), "Send time saved");
  }

  async function cancelOne(m: MessageRef) {
    try {
      await api.cancelMessage(m.id);
      setCancelled((c) => [...c, m.id]);
      toast.success(`${kindLabel(m)} cancelled`);
      onDone();
    } catch (err) {
      toast.error(describe(err));
    }
  }

  const now = new Date();
  return (
    <div className="flex items-center justify-end gap-1.5">
      {review.map((m) => (
        <Button
          key={m.id}
          variant="outline"
          size="sm"
          className="border-st-amber/40 text-st-amber hover:bg-st-amber-bg hover:text-st-amber"
          aria-label={`${kindLabel(m)} delivery unknown. Resolve`}
          onClick={() => {
            setError(null);
            setResolving(null);
            setResolveMsg(m);
          }}
        >
          <TriangleAlert />
          Resolve
        </Button>
      ))}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${contact.email}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {canSchedule && (
              <DropdownMenuItem
                onSelect={() => {
                  setWhen(initial ? toLocalInputValue(new Date(initial.scheduledFor)) : "");
                  setError(null);
                  setEditing(true);
                }}
              >
                <CalendarClock />
                {initial ? "Reschedule" : "Schedule"}
              </DropdownMenuItem>
            )}
            {pending.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => void cancelOne(m)}>
                Cancel {m.kind === "followup" ? "follow-up" : "send"}
              </DropdownMenuItem>
            ))}
            {(canSchedule || pending.length > 0) && (!closed || contact.status !== "opted_out") && <DropdownMenuSeparator />}
            {!closed && <DropdownMenuItem onSelect={() => setConfirm("replied")}>Mark replied</DropdownMenuItem>}
            {contact.status !== "opted_out" && (
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("opt-out")}>
                Opt out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={editing} onOpenChange={(o) => !o && setEditing(false)}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={save} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{initial ? "Reschedule" : "Schedule"} email</DialogTitle>
              <DialogDescription className="break-all">{contact.email}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor={`when-${contact.id}`}>New send time for {contact.email}</Label>
              <Input
                id={`when-${contact.id}`}
                type="datetime-local"
                value={when}
                min={toLocalInputValue(new Date(now.getTime() + 60_000))}
                max={toLocalInputValue(new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000))}
                onChange={(e) => setWhen(e.target.value)}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Keep
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "opt-out" ? "Opt out and stop all sends?" : "Mark as replied and cancel pending sends?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {contact.email}
              {confirm === "opt-out" ? " will not be emailed again." : " will be treated as having answered."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm === "opt-out" ? "destructive" : "default"}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run(() => (confirm === "opt-out" ? api.optOut(contact.id) : api.markReplied(contact.id)), confirm === "opt-out" ? "Opted out" : "Marked as replied");
              }}
            >
              {confirm === "opt-out" ? "Opt out" : "Mark replied"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={resolveMsg !== null} onOpenChange={(o) => !o && (setResolveMsg(null), setResolving(null))}>
        <DialogContent className="sm:max-w-md">
          {resolveMsg && (
            <>
              <DialogHeader>
                <DialogTitle>{kindLabel(resolveMsg)} delivery unknown</DialogTitle>
                <DialogDescription>
                  The send to {contact.email} was interrupted, so it is unclear whether it went out. Check your Sent folder, then choose what to record.
                </DialogDescription>
              </DialogHeader>
              {resolving ? (
                <div className="space-y-4">
                  <p className="text-[13px]">{RESOLVE_COPY[resolving].ask}</p>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setResolving(null)}>
                      Keep
                    </Button>
                    <Button variant={resolving === "requeue" ? "destructive" : "default"} disabled={busy} onClick={() => run(() => api.resolveMessage(resolveMsg.id, resolving), "Settled")}>
                      {RESOLVE_COPY[resolving].confirm}
                    </Button>
                  </DialogFooter>
                </div>
              ) : (
                <ul className="space-y-2">
                  {(Object.keys(RESOLVE_COPY) as ResolveAction[]).map((action) => (
                    <li key={action}>
                      <button
                        type="button"
                        onClick={() => setResolving(action)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30"
                      >
                        <span className="text-[13px] font-medium">{RESOLVE_COPY[action].label}</span>
                        <span className="text-xs text-muted-foreground">{RESOLVE_COPY[action].hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResumePick({ contact, resumes, onDone }: { contact: ContactListItem; resumes: Resume[]; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const def = resumes.find((r) => r.isDefault);
  async function change(value: string) {
    setBusy(true);
    setError(null);
    try {
      await api.setContactResume(contact.id, value || null);
      onDone();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-1.5 w-56 max-w-full">
      <label className="sr-only" htmlFor={`rs-${contact.id}`}>
        Resume for {contact.email}
      </label>
      <NativeSelect id={`rs-${contact.id}`} className="[&_select]:h-7 [&_select]:text-xs" value={contact.resumeId ?? ""} disabled={busy} onChange={(e) => change(e.target.value)}>
        <option value="">{def ? `Default (${def.displayName})` : "Default"}</option>
        {resumes.map((r) => (
          <option key={r.id} value={r.id}>
            {r.displayName}
          </option>
        ))}
      </NativeSelect>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function NextSend({ contact }: { contact: ContactListItem }) {
  const next = contact.messages.find((m) => m.state === "scheduled" || m.state === "sending");
  const lastSent = [...contact.messages].reverse().find((m) => m.state === "sent");
  const review = contact.messages.find((m) => m.state === "needs_review" || m.state === "failed");
  return (
    <div className="space-y-1">
      {next ? (
        <div className="flex items-center gap-2">
          <Postmark at={next.scheduledFor} label={kindLabel(next)} />
          <span className="rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground">{kindLabel(next)}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">Nothing scheduled</span>
      )}
      {lastSent?.sentAt && <div className="text-xs text-muted-foreground">Sent {formatDateTime(lastSent.sentAt)}</div>}
      {review && (
        <span className="inline-block rounded-md bg-st-red-bg px-1.5 py-0.5 text-[11px] font-medium text-st-red">
          {kindLabel(review)} {statusLabel(review.state).toLowerCase()}
        </span>
      )}
    </div>
  );
}

export function ContactsView({ initialBatchId, initialStatus }: { initialBatchId?: string; initialStatus?: string }) {
  const { mode } = useMode();
  const [status, setStatus] = useState<ContactStatus | "">(isStatus(initialStatus) ? initialStatus : "");
  const [batchId, setBatchId] = useState(initialBatchId ?? "");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [data, setData] = useState<ContactsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api.listBatches().then(setBatches, () => {});
  }, [tick]);

  useEffect(() => {
    api.listResumes().then(setResumes, () => {});
  }, []);

  useEffect(() => {
    let live = true;
    api
      .listContacts({ status: status || undefined, q: q || undefined, batchId: batchId || undefined, page, pageSize: PAGE_SIZE })
      .then(
        (d) => {
          if (!live) return;
          setData(d);
          setError(null);
        },
        (err) => live && setError(describe(err)),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [status, q, batchId, page, tick]);

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentBatch = batches.find((b) => b.id === batchId);

  return (
    <div>
      <PageHeader
        title="Contacts"
        description={
          <>
            {currentBatch ? `Batch “${currentBatch.name}” · ${plural(currentBatch.contactCount, "contact")}` : `All batches · ${plural(total, "contact")}`}
            {mode?.dryRun ? " · dry run: nothing is delivered" : ""}
          </>
        }
      />

      <form
        className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[14rem_11rem_minmax(0,1fr)]"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(search.trim());
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="f-batch">Batch</Label>
          <NativeSelect
            id="f-batch"
            value={batchId}
            onChange={(e) => {
              setPage(1);
              setBatchId(e.target.value);
            }}
          >
            <option value="">All batches</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.contactCount})
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-status">Status</Label>
          <NativeSelect
            id="f-status"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as ContactStatus | "");
            }}
          >
            <option value="">Any status</option>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="f-q">Search</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input id="f-q" type="search" maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email, company, role or subject" className="pl-8" />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </div>
        </div>
      </form>

      {error && (
        <Notice tone="danger" role="alert" className="mb-4">
          {error}
        </Notice>
      )}

      <div className="rounded-lg border bg-card" aria-busy={loading}>
        <Table className="min-w-[60rem]">
          <caption className="sr-only">Contacts matching the filters</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Recipient</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next send</TableHead>
              <TableHead>Follow-up</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data &&
              loading &&
              [0, 1, 2, 3, 4].map((i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell className="pl-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-1.5 h-3 w-52" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-8 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-32" />
                  </TableCell>
                  <TableCell className="pr-4">
                    <Skeleton className="ml-auto h-7 w-7" />
                  </TableCell>
                </TableRow>
              ))}
            {data?.contacts.map((c) => (
              <TableRow key={c.id} className="align-top">
                <TableCell className="max-w-72 pl-4">
                  <div className="truncate font-medium">{c.person}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{c.email}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.company} · {c.role}
                  </div>
                  {c.error && <div className="mt-1 text-xs text-destructive">{c.error}</div>}
                  {c.attachment && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                      <span className="truncate">Attachment: {c.attachment.displayName}</span>
                    </div>
                  )}
                  {resumes.length > 0 && (c.status === "uploaded" || c.status === "scheduled") && !c.messages.some((m) => m.kind === "initial" && m.state !== "scheduled") && (
                    <ResumePick key={`${c.id}:${c.resumeId ?? ""}`} contact={c} resumes={resumes} onDone={reload} />
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                  {c.repliedAt && <div className="mt-1 text-xs text-muted-foreground">{formatDateTime(c.repliedAt)}</div>}
                </TableCell>
                <TableCell>
                  <NextSend contact={c} />
                </TableCell>
                <TableCell>
                  <FollowupToggle
                    key={`${c.id}:${c.followupRequested}:${c.followupDelayDays}`}
                    contact={c}
                    disabled={c.status === "replied" || c.status === "opted_out" || c.status === "bounced"}
                    onChange={reload}
                  />
                </TableCell>
                <TableCell className="pr-4">
                  <RowActions contact={c} onDone={reload} />
                </TableCell>
              </TableRow>
            ))}
            {data && data.contacts.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-14 text-center whitespace-normal">
                  <Users aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="text-muted-foreground">No contacts match these filters. Clear the search or pick another status.</p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <nav className="flex items-center justify-between gap-3 border-t px-4 py-2.5" aria-label="Pages">
          <span className="text-xs text-muted-foreground tabular-nums">{total ? `${from}–${to} of ${total}` : ""}</span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
              Next
              <ChevronRight />
            </Button>
          </div>
        </nav>
      </div>
    </div>
  );
}
