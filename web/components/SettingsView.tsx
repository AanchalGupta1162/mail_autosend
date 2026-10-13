"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { fillTemplate, PLACEHOLDERS, validateTemplate } from "@/lib/template";
import type { FollowupTemplate } from "@/lib/types";
import { ResumesPanel } from "./ResumesPanel";

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

  if (!tpl) return <p className="muted">{note?.text ?? "Loading…"}</p>;

  return (
    <form className="settings-form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor="tpl-subject">Subject</label>
        <input
          id="tpl-subject"
          maxLength={200}
          value={tpl.subject}
          onChange={(e) => setTpl({ ...tpl, subject: e.target.value })}
          aria-invalid={errors.subject ? true : undefined}
          aria-describedby={errors.subject ? "tpl-subject-err" : undefined}
        />
        {errors.subject && (
          <p className="field-error" id="tpl-subject-err">
            {errors.subject}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="tpl-body">Text</label>
        <textarea
          id="tpl-body"
          rows={9}
          maxLength={5000}
          value={tpl.body}
          onChange={(e) => setTpl({ ...tpl, body: e.target.value })}
          aria-invalid={errors.body ? true : undefined}
          aria-describedby={`tpl-help${errors.body ? " tpl-body-err" : ""}`}
        />
        {errors.body && (
          <p className="field-error" id="tpl-body-err">
            {errors.body}
          </p>
        )}
      </div>
      <div className="placeholder-help" id="tpl-help">
        <p className="hint">Placeholders. A contact&apos;s own Follow-up Text column, when filled, replaces this text.</p>
        <dl className="placeholders">
          {PLACEHOLDERS.map((p) => (
            <div key={p.name}>
              <dt className="mono">{`{{${p.name}}}`}</dt>
              <dd>{p.help}</dd>
            </div>
          ))}
        </dl>
      </div>
      <article className="letter" aria-label="Preview with a sample contact">
        <dl className="letter-head">
          <div>
            <dt>Subject</dt>
            <dd>{fillTemplate(tpl.subject, SAMPLE).replace(/[\r\n]+/g, " ")}</dd>
          </div>
        </dl>
        <pre className="letter-body">{fillTemplate(tpl.body, SAMPLE)}</pre>
      </article>
      {note && (
        <p className={`callout ${note.kind === "ok" ? "callout-success" : "callout-danger"}`} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save template"}
        </button>
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
    <form className="settings-form" onSubmit={onSubmit} noValidate>
      {/* Lets password managers associate the change with the account. */}
      <input type="text" name="username" autoComplete="username" hidden readOnly value="" />
      <div className="field">
        <label htmlFor="pw-current">Current password</label>
        <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw-new">New password</label>
        <input id="pw-new" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-hint" />
        <p className="hint" id="pw-hint">
          At least 10 characters.
        </p>
      </div>
      <div className="field">
        <label htmlFor="pw-confirm">Repeat new password</label>
        <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {note && (
        <p className={`callout ${note.kind === "ok" ? "callout-success" : "callout-danger"}`} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

export function SettingsView() {
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <section className="panel" aria-labelledby="h-template">
        <h2 id="h-template" className="panel-title">
          Follow-up template
        </h2>
        <TemplateForm />
      </section>
      <section className="panel" aria-labelledby="h-resumes">
        <h2 id="h-resumes" className="panel-title">
          Resumes
        </h2>
        <ResumesPanel />
      </section>
      <section className="panel" aria-labelledby="h-password">
        <h2 id="h-password" className="panel-title">
          Change password
        </h2>
        <PasswordForm />
      </section>
    </div>
  );
}
