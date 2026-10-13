"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { checkSendTime, toLocalInputValue, MAX_DAYS_AHEAD } from "@/lib/schedule";
import { formatDateTime, plural, statusLabel } from "@/lib/format";
import { refusalText } from "@/lib/refusals";
import { CONTACT_STATUSES, type BatchSummary, type ContactListItem, type ContactStatus, type ContactsPage, type ResolveAction } from "@/lib/types";
import { useMode } from "./AppShell";
import { FollowupToggle } from "./FollowupToggle";
import { Postmark } from "./Postmark";
import { StatusBadge } from "./StatusBadge";

const PAGE_SIZE = 25;

const isStatus = (v: string | undefined): v is ContactStatus => !!v && (CONTACT_STATUSES as readonly string[]).includes(v);

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.refused?.[0] ? refusalText(err.refused[0].reason) : err.message;
  return "Something went wrong. Try again.";
}

type Confirm = "opt-out" | "replied" | null;

const RESOLVE_COPY: Record<ResolveAction, { label: string; ask: string; confirm: string }> = {
  mark_sent: { label: "It was sent", ask: "Check your Sent folder first. Record this email as delivered?", confirm: "Mark sent" },
  requeue: { label: "Send again", ask: "Send it again now? If it did go out, the recipient gets a duplicate.", confirm: "Send again" },
  cancel: { label: "Drop it", ask: "Drop this email? It will not be sent.", confirm: "Drop email" },
};

function RowActions({ contact, onDone }: { contact: ContactListItem; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [resolving, setResolving] = useState<{ id: string; action: ResolveAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hide a cancelled send at once, before the list reload replaces this row's data.
  const [cancelled, setCancelled] = useState<string[]>([]);

  const initial = contact.messages.find((m) => m.kind === "initial");
  const pending = contact.messages.filter((m) => m.state === "scheduled" && !cancelled.includes(m.id));
  const canSchedule = (contact.status === "uploaded" || contact.status === "scheduled") && (!initial || initial.state === "scheduled");
  const review = contact.messages.filter((m) => m.state === "needs_review");
  const closed = contact.status === "replied" || contact.status === "opted_out";

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(false);
      setConfirm(null);
      setResolving(null);
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
    void run(() => api.scheduleContact(contact.id, r.at!.toISOString()));
  }

  const now = new Date();
  return (
    <div className="row-actions">
      {editing ? (
        <form className="inline-form" onSubmit={save}>
          <label className="sr-only" htmlFor={`when-${contact.id}`}>
            New send time for {contact.email}
          </label>
          <input
            id={`when-${contact.id}`}
            type="datetime-local"
            value={when}
            min={toLocalInputValue(new Date(now.getTime() + 60_000))}
            max={toLocalInputValue(new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000))}
            onChange={(e) => setWhen(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditing(false)}>
            Keep
          </button>
        </form>
      ) : resolving ? (
        <div className="inline-form">
          <span className="confirm-text">{RESOLVE_COPY[resolving.action].ask}</span>
          <button
            type="button"
            className={`btn btn-small ${resolving.action === "requeue" ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={() => run(() => api.resolveMessage(resolving.id, resolving.action))}
          >
            {RESOLVE_COPY[resolving.action].confirm}
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setResolving(null)}>
            Keep
          </button>
        </div>
      ) : confirm ? (
        <div className="inline-form">
          <span className="confirm-text">{confirm === "opt-out" ? "Opt out and stop all sends?" : "Mark as replied and cancel pending sends?"}</span>
          <button
            type="button"
            className={`btn btn-small ${confirm === "opt-out" ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={() => run(() => (confirm === "opt-out" ? api.optOut(contact.id) : api.markReplied(contact.id)))}
          >
            {confirm === "opt-out" ? "Opt out" : "Mark replied"}
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirm(null)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="action-row">
          {canSchedule && (
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setWhen(initial ? toLocalInputValue(new Date(initial.scheduledFor)) : "");
                setEditing(true);
              }}
            >
              {initial ? "Reschedule" : "Schedule"}
            </button>
          )}
          {review.map((m) => (
            <span key={m.id} className="action-row" role="group" aria-label={`${m.kind === "followup" ? "Follow-up" : "First email"} delivery unknown`}>
              <span className="muted">{m.kind === "followup" ? "Follow-up" : "First email"} delivery unknown:</span>
              {(Object.keys(RESOLVE_COPY) as ResolveAction[]).map((action) => (
                <button key={action} type="button" className="btn-link" onClick={() => setResolving({ id: m.id, action })}>
                  {RESOLVE_COPY[action].label}
                </button>
              ))}
            </span>
          ))}
          {pending.map((m) => (
            <button key={m.id} type="button" className="btn-link" disabled={busy} onClick={() => run(async () => {
                await api.cancelMessage(m.id);
                setCancelled((c) => [...c, m.id]);
              })}>
              Cancel {m.kind === "followup" ? "follow-up" : "send"}
            </button>
          ))}
          {!closed && (
            <button type="button" className="btn-link" onClick={() => setConfirm("replied")}>
              Mark replied
            </button>
          )}
          {contact.status !== "opted_out" && (
            <button type="button" className="btn-link btn-link-danger" onClick={() => setConfirm("opt-out")}>
              Opt out
            </button>
          )}
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function NextSend({ contact }: { contact: ContactListItem }) {
  const next = contact.messages.find((m) => m.state === "scheduled" || m.state === "sending");
  const lastSent = [...contact.messages].reverse().find((m) => m.state === "sent");
  const review = contact.messages.find((m) => m.state === "needs_review" || m.state === "failed");
  return (
    <div className="next-send">
      {next ? (
        <>
          <Postmark at={next.scheduledFor} label={next.kind === "followup" ? "Follow-up" : "First email"} />
          <span className="tag">{next.kind === "followup" ? "Follow-up" : "First email"}</span>
        </>
      ) : (
        <span className="muted">Nothing scheduled</span>
      )}
      {lastSent?.sentAt && <span className="cell-secondary">Sent {formatDateTime(lastSent.sentAt)}</span>}
      {review && (
        <span className="tag tag-danger">
          {review.kind === "followup" ? "Follow-up" : "First email"} {statusLabel(review.state).toLowerCase()}
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
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api.listBatches().then(setBatches, () => {});
  }, [tick]);

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
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Contacts</h1>
          <p className="page-sub">
            {currentBatch ? `Batch “${currentBatch.name}” · ${plural(currentBatch.contactCount, "contact")}` : `All batches · ${plural(total, "contact")}`}
            {mode?.dryRun ? " · dry run: nothing is delivered" : ""}
          </p>
        </div>
      </header>

      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(search.trim());
        }}
      >
        <div className="field">
          <label htmlFor="f-batch">Batch</label>
          <select
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
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select
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
          </select>
        </div>
        <div className="field field-grow">
          <label htmlFor="f-q">Search</label>
          <div className="input-group">
            <input id="f-q" type="search" maxLength={200} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email, company, role or subject" />
            <button type="submit" className="btn btn-quiet">
              Search
            </button>
          </div>
        </div>
      </form>

      {error && (
        <p className="callout callout-danger" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap" aria-busy={loading}>
        <table className="table">
          <caption className="sr-only">Contacts matching the filters</caption>
          <thead>
            <tr>
              <th scope="col">Recipient</th>
              <th scope="col">Status</th>
              <th scope="col">Next send</th>
              <th scope="col">Follow-up</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data?.contacts.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="cell-primary">{c.person}</div>
                  <div className="cell-secondary mono">{c.email}</div>
                  <div className="cell-secondary">
                    {c.company} · {c.role}
                  </div>
                  {c.error && <div className="field-error">{c.error}</div>}
                </td>
                <td>
                  <StatusBadge status={c.status} />
                  {c.repliedAt && <div className="cell-secondary">{formatDateTime(c.repliedAt)}</div>}
                </td>
                <td>
                  <NextSend contact={c} />
                </td>
                <td>
                  <FollowupToggle
                    key={`${c.id}:${c.followupRequested}:${c.followupDelayDays}`}
                    contact={c}
                    disabled={c.status === "replied" || c.status === "opted_out" || c.status === "bounced"}
                    onChange={reload}
                  />
                </td>
                <td>
                  <RowActions contact={c} onDone={reload} />
                </td>
              </tr>
            ))}
            {data && data.contacts.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No contacts match these filters. Clear the search or pick another status.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <nav className="pager" aria-label="Pages">
        <span className="hint">{total ? `${from}–${to} of ${total}` : ""}</span>
        <div className="pager-buttons">
          <button type="button" className="btn btn-quiet btn-small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <button type="button" className="btn btn-quiet btn-small" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </nav>
    </div>
  );
}
