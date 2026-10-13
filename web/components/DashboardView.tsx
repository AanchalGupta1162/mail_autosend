"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { eventLabel, formatDateTime, formatShort, percent, plural, statusLabel } from "@/lib/format";
import type { ContactStatus, Dashboard, SweepResult } from "@/lib/types";
import { useMode } from "./AppShell";
import { Postmark } from "./Postmark";

// Charts are SVG with presentation attributes only (no style attributes: strict CSP).
const PIPELINE: ContactStatus[] = ["uploaded", "scheduled", "sent", "replied"];
const OUTCOMES: ContactStatus[] = ["bounced", "opted_out", "failed"];

function Bars({ items, max }: { items: { key: string; label: string; value: number }[]; max: number }) {
  return (
    <ul className="bars">
      {items.map((it) => {
        const w = max > 0 ? Math.max(it.value > 0 ? 1.5 : 0, (it.value / max) * 100) : 0;
        return (
          <li key={it.key} className="bar">
            <span className="bar-label">{it.label}</span>
            <svg className="bar-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <rect className="bar-bg" x="0" y="0" width="100" height="10" rx="1" />
              <rect className={`bar-fill fill-${it.key}`} x="0" y="0" width={w} height="10" rx="1" />
            </svg>
            <span className="bar-value mono">{it.value}</span>
          </li>
        );
      })}
    </ul>
  );
}

function CapMeter({ sent, cap }: { sent: number; cap: number }) {
  const ratio = cap > 0 ? Math.min(1, sent / cap) : 0;
  return (
    <div className="meter">
      <p className="kpi-value">
        <span className="mono">{sent}</span>
        <span className="kpi-of"> / {cap}</span>
      </p>
      <svg className="meter-track" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`${sent} of ${cap} daily sends used`}>
        <rect className="bar-bg" x="0" y="0" width="100" height="6" rx="1" />
        <rect className={`bar-fill ${ratio >= 0.9 ? "fill-warn" : "fill-sent"}`} x="0" y="0" width={ratio * 100} height="6" rx="1" />
      </svg>
    </div>
  );
}

function sweepSummary(r: SweepResult): string {
  if (r.skipped) return r.reason === "dry_run" ? "Skipped: dry run has no inbox to check." : "A check is already running.";
  if (r.error) return "The inbox check failed. See the status above.";
  return `Checked ${plural(r.checked ?? 0, "thread")}, found ${plural(r.replied ?? 0, "reply", "replies")}.`;
}

export function DashboardView() {
  const { setMode } = useMode();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getDashboard().then(
      (d) => {
        setData(d);
        setError(null);
        setMode({ dryRun: d.dryRun, followupsHeld: d.followupsHeld });
      },
      (err) => setError(err instanceof ApiError ? err.message : "Could not load the dashboard."),
    );
  }, [setMode]);

  useEffect(() => {
    load();
  }, [load]);

  async function sweep() {
    setSweeping(true);
    setSweepNote(null);
    try {
      setSweepNote(sweepSummary(await api.runSweep()));
      load();
    } catch (err) {
      setSweepNote(err instanceof ApiError ? err.message : "Could not start the check.");
    } finally {
      setSweeping(false);
    }
  }

  if (error && !data) {
    return (
      <div className="page">
        <h1>Dashboard</h1>
        <p className="callout callout-danger" role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page" aria-busy="true">
        <h1>Dashboard</h1>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const t = data.totals;
  const pipelineMax = Math.max(1, ...PIPELINE.map((s) => t[s]), ...OUTCOMES.map((s) => t[s]));
  const companyMax = Math.max(1, ...data.byCompany.map((c) => c.total));
  const sw = data.sweep;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="page-sub">{data.dryRun ? "Dry run: counts reflect simulated sends." : "Live: counts reflect delivered email."}</p>
        </div>
        <button type="button" className="btn btn-quiet" onClick={load}>
          Refresh
        </button>
      </header>

      <section className="kpis" aria-label="Today">
        <div className="kpi">
          <h2 className="kpi-label">Sent in the last 24 h</h2>
          <CapMeter sent={data.sentToday} cap={data.dailyCap} />
        </div>
        <div className="kpi">
          <h2 className="kpi-label">Reply rate</h2>
          <p className="kpi-value mono">{percent(data.repliedRate)}</p>
          <p className="hint">of contacts whose first email was sent</p>
        </div>
        <div className="kpi">
          <h2 className="kpi-label">Waiting to send</h2>
          <p className="kpi-value mono">{t.scheduled}</p>
          <p className="hint">contacts scheduled</p>
        </div>
        <div className="kpi">
          <h2 className="kpi-label">Needs a look</h2>
          <p className="kpi-value mono">{t.failed + t.bounced}</p>
          <p className="hint">
            <Link href="/contacts?status=failed">failed</Link> or <Link href="/contacts?status=bounced">bounced</Link>
          </p>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel" aria-labelledby="h-pipeline">
          <h2 id="h-pipeline" className="panel-title">
            Pipeline
          </h2>
          <Bars items={PIPELINE.map((s) => ({ key: s, label: statusLabel(s), value: t[s] }))} max={pipelineMax} />
          <h3 className="panel-subtitle">Stopped</h3>
          <Bars items={OUTCOMES.map((s) => ({ key: s, label: statusLabel(s), value: t[s] }))} max={pipelineMax} />
        </section>

        <section className="panel" aria-labelledby="h-upcoming">
          <h2 id="h-upcoming" className="panel-title">
            Next sends
          </h2>
          {data.upcoming.length === 0 ? (
            <p className="empty">
              Nothing scheduled. <Link href="/upload">Upload a CSV</Link> to plan the next batch.
            </p>
          ) : (
            <ol className="upcoming">
              {data.upcoming.map((u) => (
                <li key={u.messageId}>
                  <Postmark at={u.scheduledFor} />
                  <div>
                    <div className="cell-primary">{u.person}</div>
                    <div className="cell-secondary mono">{u.email}</div>
                  </div>
                  <span className="tag">{u.kind === "followup" ? "Follow-up" : u.company}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="panel" aria-labelledby="h-companies">
          <h2 id="h-companies" className="panel-title">
            Top companies
          </h2>
          {data.byCompany.length === 0 ? (
            <p className="empty">No contacts yet.</p>
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th scope="col">Company</th>
                  <th scope="col" className="num">Contacts</th>
                  <th scope="col" className="num">Sent</th>
                  <th scope="col" className="num">Replied</th>
                </tr>
              </thead>
              <tbody>
                {data.byCompany.map((c) => (
                  <tr key={c.company}>
                    <td>
                      <div className="cell-primary">{c.company}</div>
                      <svg className="bar-track bar-inline" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                        <rect className="bar-fill fill-uploaded" x="0" y="0" width={(c.total / companyMax) * 100} height="4" />
                        <rect className="bar-fill fill-sent" x="0" y="0" width={(c.sent / companyMax) * 100} height="4" />
                        <rect className="bar-fill fill-replied" x="0" y="0" width={(c.replied / companyMax) * 100} height="4" />
                      </svg>
                    </td>
                    <td className="num mono">{c.total}</td>
                    <td className="num mono">{c.sent}</td>
                    <td className="num mono">{c.replied}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel" aria-labelledby="h-events">
          <h2 id="h-events" className="panel-title">
            Recent activity
          </h2>
          {data.recentEvents.length === 0 ? (
            <p className="empty">No activity yet.</p>
          ) : (
            <ol className="events">
              {data.recentEvents.map((e) => (
                <li key={e.id}>
                  <time className="mono event-time" dateTime={e.at}>
                    {formatShort(e.at)}
                  </time>
                  <span className="event-type">{eventLabel(e.type)}</span>
                  {e.email && <span className="cell-secondary mono">{e.email}</span>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="panel" id="replies" aria-labelledby="h-replies">
        <div className="panel-head">
          <h2 id="h-replies" className="panel-title">
            Reply checks
          </h2>
          <button type="button" className="btn btn-quiet btn-small" onClick={sweep} disabled={sweeping}>
            {sweeping ? "Checking…" : "Check replies now"}
          </button>
        </div>
        {data.followupsHeld && (
          <p className="callout callout-warning">Follow-ups are on hold until a reply check succeeds. First emails are not affected.</p>
        )}
        {sw ? (
          <dl className="facts">
            <div>
              <dt>Last check</dt>
              <dd>
                {formatDateTime(sw.at)} · <span className={sw.ok ? "ok-text" : "danger-text"}>{sw.ok ? "succeeded" : `failed${sw.errorCode ? ` (${sw.errorCode})` : ""}`}</span>
              </dd>
            </div>
            <div>
              <dt>Last success</dt>
              <dd>{formatDateTime(sw.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt>Rows that errored</dt>
              <dd className="mono">{sw.rowErrors}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">{data.dryRun ? "Reply checks don't run in dry run." : "No reply check has run yet."}</p>
        )}
        {sweepNote && (
          <p className="hint" role="status">
            {sweepNote}
          </p>
        )}
      </section>
    </div>
  );
}
