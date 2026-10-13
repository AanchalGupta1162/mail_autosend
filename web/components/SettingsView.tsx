"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { fillTemplate, PLACEHOLDERS, validateTemplate } from "@/lib/template";
import type { Dashboard, FollowupTemplate } from "@/lib/types";
import { ResumesPanel } from "./ResumesPanel";
import { Loader2 } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmailLetter } from "./EmailLetter";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { SendHoldBanner } from "./SendHoldBanner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE = { person: "Aisha Rao", role: "Software Engineer Intern", company: "Northwind Labs", subject: "Software Engineer Intern role at Northwind Labs" };

function TemplateForm() {
  const [tpl, setTpl] = useState<FollowupTemplate | null>(null);
  const [errors, setErrors] = useState<{ subject?: string; body?: string }>({});
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getFollowupTemplate().then(setTpl, (err) => setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not load the template." }));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!tpl) return;
    const v = validateTemplate(tpl);
    setErrors(v);
    setNote(null);
    if (v.subject || v.body) return;
    setBusy(true);
    try {
      setTpl(await api.saveFollowupTemplate({ subject: tpl.subject.trim(), body: tpl.body }));
      setNote({ kind: "ok", text: "Template saved. New follow-ups use it; already-sent ones are unchanged." });
    } catch (err) {
      setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not save the template." });
    } finally {
      setBusy(false);
    }
  }

  if (!tpl) return <p className="text-[13px] text-muted-foreground">{note?.text ?? "Loading…"}</p>;

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="tpl-subject">Subject</Label>
        <Input
          id="tpl-subject"
          maxLength={200}
          value={tpl.subject}
          onChange={(e) => setTpl({ ...tpl, subject: e.target.value })}
          aria-invalid={errors.subject ? true : undefined}
          aria-describedby={errors.subject ? "tpl-subject-err" : undefined}
        />
        {errors.subject && (
          <p className="text-xs text-destructive" id="tpl-subject-err">
            {errors.subject}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tpl-body">Text</Label>
        <Textarea
          id="tpl-body"
          rows={9}
          maxLength={5000}
          value={tpl.body}
          onChange={(e) => setTpl({ ...tpl, body: e.target.value })}
          aria-invalid={errors.body ? true : undefined}
          aria-describedby={`tpl-help${errors.body ? " tpl-body-err" : ""}`}
          className="font-mono text-xs leading-5"
        />
        {errors.body && (
          <p className="text-xs text-destructive" id="tpl-body-err">
            {errors.body}
          </p>
        )}
      </div>
      <div className="space-y-2 rounded-lg border bg-muted/40 p-3" id="tpl-help">
        <p className="text-xs text-muted-foreground">Placeholders. A contact&apos;s own Follow-up Text column, when filled, replaces this text.</p>
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr]">
          {PLACEHOLDERS.map((p) => (
            <div key={p.name} className="contents">
              <dt className="font-mono text-xs text-accent-text">{`{{${p.name}}}`}</dt>
              <dd className="text-xs text-muted-foreground">{p.help}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Preview with a sample contact</p>
        <EmailLetter label="Preview with a sample contact" subject={fillTemplate(tpl.subject, SAMPLE).replace(/[\r\n]+/g, " ")} body={fillTemplate(tpl.body, SAMPLE)} />
      </div>
      {note && (
        <Notice tone={note.kind === "ok" ? "success" : "danger"} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Saving…" : "Save template"}
        </Button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    if (!current) return setNote({ kind: "err", text: "Enter your current password." });
    if (next.length < 10) return setNote({ kind: "err", text: "New password must be at least 10 characters." });
    if (next === current) return setNote({ kind: "err", text: "New password must differ from the current one." });
    if (next !== confirm) return setNote({ kind: "err", text: "The two new passwords don't match." });
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setNote({ kind: "ok", text: "Password changed. Other signed-in sessions were signed out." });
    } catch (err) {
      setCurrent("");
      setNote({ kind: "err", text: err instanceof ApiError && err.status === 400 ? err.message : "Could not change the password. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {/* Lets password managers associate the change with the account. */}
      <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
      <div className="space-y-1.5">
        <Label htmlFor="pw-current">Current password</Label>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pw-new">New password</Label>
        <Input id="pw-new" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-hint" />
        <p className="text-xs text-muted-foreground" id="pw-hint">
          At least 10 characters.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pw-confirm">Repeat new password</Label>
        <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {note && (
        <Notice tone={note.kind === "ok" ? "success" : "danger"} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Changing…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

function SendStatus() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.getDashboard().then(setD, () => setFailed(true));
  }, []);
  if (failed) return <p className="text-[13px] text-muted-foreground">Could not load the sending status.</p>;
  if (!d) return <Skeleton className="h-20 w-full" />;
  const row = "flex items-center justify-between gap-4 py-2.5 text-[13px]";
  return (
    <div className="space-y-4">
      <dl className="divide-y">
        <div className={row}>
          <dt className="text-muted-foreground">Mode</dt>
          <dd>
            <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium", d.dryRun ? "bg-st-amber-bg text-st-amber" : "bg-st-green-bg text-st-green")}>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              {d.dryRun ? "Dry run" : "Live sending"}
            </span>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Sent in the last 24 h</dt>
          <dd className="tabular-nums">
            {d.sentToday} <span className="text-muted-foreground">of {d.dailyCap}</span>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Follow-ups</dt>
          <dd>{d.followupsHeld ? <span className="font-medium text-st-amber">On hold</span> : "Sending"}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Last reply check</dt>
          <dd>{d.sweep ? `${formatDateTime(d.sweep.at)} · ${d.sweep.ok ? "succeeded" : "failed"}` : d.dryRun ? "Not run in dry run" : "Not run yet"}</dd>
        </div>
      </dl>
      {d.sendHold && <SendHoldBanner hold={d.sendHold} />}
    </div>
  );
}

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-4 py-8 first:pt-0 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
      <div className="space-y-1">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0 rounded-lg border bg-card p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function SettingsView() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Settings" description="Your account, the resume library, and how follow-ups read." />
      <div className="divide-y">
        <Section id="h-status" title="Sending" description="The server's current mode and limits.">
          <SendStatus />
        </Section>
        <Section id="h-resumes" title="Resumes" description="PDFs you can attach. The default goes with every email unless you pick another.">
          <ResumesPanel />
        </Section>
        <Section id="h-template" title="Follow-up template" description="Used for follow-ups when a contact has no text of its own.">
          <TemplateForm />
        </Section>
        <Section id="h-password" title="Account" description="Change your password. Other signed-in sessions are signed out.">
          <PasswordForm />
        </Section>
      </div>
    </div>
  );
}
