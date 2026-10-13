"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarClock, Inbox, Loader2, RefreshCw } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { eventLabel, formatDateTime, formatShort, percent, plural, statusLabel } from "@/lib/format";
import type { ContactStatus, Dashboard, SweepResult } from "@/lib/types";
import { useMode } from "./AppShell";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Postmark } from "./Postmark";
import { SendHoldBanner } from "./SendHoldBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Charts are SVG with presentation attributes only (no style attributes: strict CSP).
const PIPELINE: ContactStatus[] = ["uploaded", "scheduled", "sent", "replied"];
const OUTCOMES: ContactStatus[] = ["bounced", "opted_out", "failed"];

const FILL: Record<string, string> = {
  uploaded: "fill-muted-foreground/45",
  scheduled: "fill-st-indigo",
  sent: "fill-st-green",
  replied: "fill-st-violet",
  bounced: "fill-st-red",
  opted_out: "fill-muted-foreground/45",
  failed: "fill-st-red",
  warn: "fill-st-amber",
};

function Bars({ items, max }: { items: { key: string; label: string; value: number }[]; max: number }) {
  return (
    <ul className="space-y-2.5">
      {items.map((it) => {
        const w = max > 0 ? Math.max(it.value > 0 ? 1.5 : 0, (it.value / max) * 100) : 0;
        return (
          <li key={it.key} className="grid grid-cols-[6.5rem_1fr_2rem] items-center gap-3">
            <span className="truncate text-[13px] text-muted-foreground">{it.label}</span>
            <svg className="h-2 w-full" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <rect className="fill-muted" x="0" y="0" width="100" height="10" rx="2" />
              <rect className={FILL[it.key]} x="0" y="0" width={w} height="10" rx="2" />
            </svg>
            <span className="text-right text-[13px] tabular-nums">{it.value}</span>
          </li>
        );
      })}
    </ul>
  );
}

function CapMeter({ sent, cap }: { sent: number; cap: number }) {
  const ratio = cap > 0 ? Math.min(1, sent / cap) : 0;
  return (
    <div className="space-y-2.5">
      <p className="flex items-baseline gap-1 text-2xl font-semibold tracking-tight">
        <span className="tabular-nums">{sent}</span>
        <span className="text-sm font-normal text-muted-foreground">/ {cap}</span>
      </p>
      <svg className="h-1.5 w-full" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`${sent} of ${cap} daily sends used`}>
        <rect className="fill-muted" x="0" y="0" width="100" height="6" rx="1.5" />
        <rect className={ratio >= 0.9 ? FILL.warn : "fill-primary"} x="0" y="0" width={ratio * 100} height="6" rx="1.5" />
      </svg>
    </div>
  );
}

function Stat({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="gap-0">
      <CardHeader className="px-4 pt-3.5 pb-1.5 sm:px-5 sm:pt-4 sm:pb-2">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
      </CardHeader>
      <CardContent className="space-y-1 px-4 pb-4 sm:px-5 sm:pb-5">
        {children}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function BigNumber({ children }: { children: React.ReactNode }) {
  return <p className="text-2xl font-semibold tracking-tight tabular-nums">{children}</p>;
}

function Empty({ icon: Icon, children }: { icon: typeof Inbox; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-8 text-center text-[13px] text-muted-foreground">
      <Icon aria-hidden="true" className="size-5" />
      <p>{children}</p>
    </div>
  );
}

function sweepSummary(r: SweepResult): string {
  if (r.skipped) return r.reason === "dry_run" ? "Skipped: dry run has no inbox to check." : "A check is already running.";
  if (r.error) return "The inbox check failed. See the status above.";
  return `Checked ${plural(r.checked ?? 0, "thread")}, found ${plural(r.replied ?? 0, "reply", "replies")}.`;
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the dashboard">
      <PageHeader title="Dashboard" description="Loading…" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-64 rounded-lg" />
        ))}
      </div>
    </div>
  );
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
      <div>
        <PageHeader title="Dashboard" />
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      </div>
    );
  }
  if (!data) return <DashboardSkeleton />;

  const t = data.totals;
  const pipelineMax = Math.max(1, ...PIPELINE.map((s) => t[s]), ...OUTCOMES.map((s) => t[s]));
  const companyMax = Math.max(1, ...data.byCompany.map((c) => c.total));
  const sw = data.sweep;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        description={data.dryRun ? "Dry run: counts reflect simulated sends." : "Live: counts reflect delivered email."}
        actions={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw />
            Refresh
          </Button>
        }
        className="mb-2"
      />

      {data.sendHold && <SendHoldBanner hold={data.sendHold} />}

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-label="Today">
        <Stat label="Sent in the last 24 h">
          <CapMeter sent={data.sentToday} cap={data.dailyCap} />
        </Stat>
        <Stat label="Reply rate" hint="of contacts whose first email was sent">
          <BigNumber>{percent(data.repliedRate)}</BigNumber>
        </Stat>
        <Stat label="Waiting to send" hint="contacts scheduled">
          <BigNumber>{t.scheduled}</BigNumber>
        </Stat>
        <Stat
          label="Needs a look"
          hint={
            <>
              <Link href="/contacts?status=failed" className="text-accent-text underline-offset-2 hover:underline">
                failed
              </Link>{" "}
              or{" "}
              <Link href="/contacts?status=bounced" className="text-accent-text underline-offset-2 hover:underline">
                bounced
              </Link>
            </>
          }
        >
          <BigNumber>{t.failed + t.bounced}</BigNumber>
        </Stat>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-0" aria-labelledby="h-pipeline" role="region">
          <CardHeader>
            <h2 id="h-pipeline" className="text-sm leading-5 font-medium">Pipeline</h2>
            <CardDescription>Where every contact stands</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Bars items={PIPELINE.map((s) => ({ key: s, label: statusLabel(s), value: t[s] }))} max={pipelineMax} />
            <div className="space-y-2.5 border-t pt-4">
              <h3 className="text-xs font-medium text-muted-foreground">Stopped</h3>
              <Bars items={OUTCOMES.map((s) => ({ key: s, label: statusLabel(s), value: t[s] }))} max={pipelineMax} />
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0" aria-labelledby="h-upcoming" role="region">
          <CardHeader>
            <h2 id="h-upcoming" className="text-sm leading-5 font-medium">Next sends</h2>
            <CardDescription>Queued in time order</CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <Link href="/contacts?status=scheduled">
                  View all <ArrowUpRight />
                </Link>
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {data.upcoming.length === 0 ? (
              <Empty icon={CalendarClock}>
                Nothing scheduled.{" "}
                <Link href="/upload" className="font-medium text-accent-text underline-offset-2 hover:underline">
                  Upload a CSV
                </Link>{" "}
                to plan the next batch.
              </Empty>
            ) : (
              <ol className="-mx-2 divide-y">
                {data.upcoming.map((u) => (
                  <li key={u.messageId} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 px-2 py-2.5 first:pt-0 last:pb-0">
                    <Postmark at={u.scheduledFor} />
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium">{u.person}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{u.email}</div>
                    </div>
                    <Badge variant="outline" className="max-w-32 truncate rounded-md text-[11px] font-normal">
                      {u.kind === "followup" ? "Follow-up" : u.company}
                    </Badge>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card className="gap-0" aria-labelledby="h-companies" role="region">
          <CardHeader>
            <h2 id="h-companies" className="text-sm leading-5 font-medium">Top companies</h2>
          </CardHeader>
          <CardContent className="px-0">
            {data.byCompany.length === 0 ? (
              <div className="px-5">
                <Empty icon={Inbox}>No contacts yet.</Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-5">Company</TableHead>
                    <TableHead className="text-right">Contacts</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="pr-5 text-right">Replied</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byCompany.map((c) => (
                    <TableRow key={c.company}>
                      <TableCell className="pl-5">
                        <div className="truncate font-medium">{c.company}</div>
                        <svg className="mt-1.5 h-1 w-full max-w-40" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                          <rect className="fill-muted" x="0" y="0" width="100" height="4" rx="1" />
                          <rect className="fill-muted-foreground/40" x="0" y="0" width={(c.total / companyMax) * 100} height="4" rx="1" />
                          <rect className={FILL.sent} x="0" y="0" width={(c.sent / companyMax) * 100} height="4" rx="1" />
                          <rect className={FILL.replied} x="0" y="0" width={(c.replied / companyMax) * 100} height="4" rx="1" />
                        </svg>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.total}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.sent}</TableCell>
                      <TableCell className="pr-5 text-right tabular-nums">{c.replied}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="gap-0" aria-labelledby="h-events" role="region">
          <CardHeader>
            <h2 id="h-events" className="text-sm leading-5 font-medium">Recent activity</h2>
          </CardHeader>
          <CardContent>
            {data.recentEvents.length === 0 ? (
              <Empty icon={Inbox}>No activity yet.</Empty>
            ) : (
              <ol className="max-h-80 space-y-0 overflow-y-auto">
                {data.recentEvents.map((e) => (
                  <li key={e.id} className="grid grid-cols-[6.75rem_1fr] items-baseline gap-x-3 border-b py-2 last:border-0 first:pt-0">
                    <time className="font-mono text-xs text-muted-foreground" dateTime={e.at}>
                      {formatShort(e.at)}
                    </time>
                    <div className="min-w-0">
                      <span className="text-[13px] font-medium">{eventLabel(e.type)}</span>
                      {e.email && <span className="ml-2 inline-block max-w-full truncate align-bottom font-mono text-xs text-muted-foreground">{e.email}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 scroll-mt-20" id="replies" aria-labelledby="h-replies" role="region">
        <CardHeader>
          <h2 id="h-replies" className="text-sm leading-5 font-medium">Reply checks</h2>
          <CardDescription>The inbox is scanned for replies so follow-ups stop on their own.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={sweep} disabled={sweeping}>
              {sweeping && <Loader2 className="animate-spin" />}
              {sweeping ? "Checking…" : "Check replies now"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.followupsHeld && (
            <Notice tone="warning">
              <p>Follow-ups are on hold until a reply check succeeds. First emails are not affected.</p>
            </Notice>
          )}
          {sw ? (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Last check</dt>
                <dd className="mt-0.5 text-[13px]">
                  {formatDateTime(sw.at)} ·{" "}
                  <span className={cn("font-medium", sw.ok ? "text-st-green" : "text-st-red")}>{sw.ok ? "succeeded" : `failed${sw.errorCode ? ` (${sw.errorCode})` : ""}`}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last success</dt>
                <dd className="mt-0.5 text-[13px]">{formatDateTime(sw.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Rows that errored</dt>
                <dd className="mt-0.5 font-mono text-[13px]">{sw.rowErrors}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-[13px] text-muted-foreground">{data.dryRun ? "Reply checks don't run in dry run." : "No reply check has run yet."}</p>
          )}
          {sweepNote && (
            <p className="text-[13px] text-muted-foreground" role="status">
              {sweepNote}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
