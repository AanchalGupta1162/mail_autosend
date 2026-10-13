"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { plural } from "@/lib/format";
import { checkResumeFile, checkResumeName, defaultNameFor, formatBytes, looksLikePdf } from "@/lib/resumes";
import type { Resume } from "@/lib/types";

function deleteMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    const n = (err.body as { pendingMessages?: unknown } | null)?.pendingMessages;
    if (typeof n === "number") {
      return `This resume is attached to ${plural(n, "email")} that ${n === 1 ? "has" : "have"} not been sent yet. Cancel ${n === 1 ? "it" : "them"} or wait until ${n === 1 ? "it is" : "they are"} sent, then delete the resume.`;
    }
  }
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

function UploadForm({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [suggested, setSuggested] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pick(f: File | undefined) {
    setFile(f ?? null);
    setError(null);
    if (f && (name === "" || name === suggested)) {
      const s = defaultNameFor(f.name);
      setSuggested(s);
      setName(s);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = checkResumeFile(file) ?? checkResumeName(name);
    if (problem) return setError(problem);
    if (!(await looksLikePdf(file!))) return setError("This file does not look like a PDF. Choose a real PDF.");
    setBusy(true);
    try {
      await api.uploadResume(file!, name);
      setFile(null);
      setName("");
      setSuggested("");
      if (input.current) input.current.value = "";
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor="resume-file">Resume file (PDF, up to 5 MB)</label>
        <input id="resume-file" ref={input} type="file" accept="application/pdf,.pdf" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      <div className="field">
        <label htmlFor="resume-name">Display name</label>
        <input id="resume-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Backend roles" />
        <p className="hint">Shown when you choose which resume to attach.</p>
      </div>
      {error && (
        <p className="callout callout-danger" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Uploading…" : "Upload resume"}
        </button>
      </div>
    </form>
  );
}

function ResumeItem({ resume, onChanged, onError }: { resume: Resume; onChanged: () => void; onError: (m: string | null) => void }) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(resume.displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const u = resume.usage;
  const inUse = [u.pendingMessages && plural(u.pendingMessages, "scheduled email"), u.batches && plural(u.batches, "batch", "batches"), u.contacts && plural(u.contacts, "contact")].filter(Boolean) as string[];

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      setMode("view");
      onChanged();
    } catch (err) {
      onError(deleteMessage(err));
      setMode("view");
    } finally {
      setBusy(false);
    }
  }

  function saveName(e: FormEvent) {
    e.preventDefault();
    const problem = checkResumeName(name);
    setNameError(problem);
    if (problem) return;
    void run(() => api.updateResume(resume.id, { displayName: name.trim() }));
  }

  return (
    <li className="resume-item">
      <div className="resume-main">
        <span className="cell-primary">{resume.displayName}</span>
        {resume.isDefault && <span className="tag tag-success">Default</span>}
        <span className="cell-secondary mono">{resume.fileName}</span>
        <span className="cell-secondary">{formatBytes(resume.sizeBytes)}</span>
        {inUse.map((t) => (
          <span key={t} className="cell-secondary">
            {t}
          </span>
        ))}
      </div>
      {mode === "rename" ? (
        <form className="inline-form" onSubmit={saveName} noValidate>
          <label className="sr-only" htmlFor={`rn-${resume.id}`}>
            New name for {resume.displayName}
          </label>
          <input id={`rn-${resume.id}`} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameError ? true : undefined} />
          <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
            Save name
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setMode("view")}>
            Keep
          </button>
          {nameError && <p className="field-error">{nameError}</p>}
        </form>
      ) : mode === "delete" ? (
        <div className="inline-form">
          <span className="confirm-text">Delete this resume? Emails already sent are not affected.</span>
          <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => run(() => api.deleteResume(resume.id))}>
            Delete resume
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setMode("view")}>
            Keep
          </button>
        </div>
      ) : (
        <div className="action-row">
          {!resume.isDefault && (
            <button type="button" className="btn-link" disabled={busy} aria-label={`Make ${resume.displayName} the default`} onClick={() => run(() => api.updateResume(resume.id, { isDefault: true }))}>
              Make default
            </button>
          )}
          <button
            type="button"
            className="btn-link"
            aria-label={`Rename ${resume.displayName}`}
            onClick={() => {
              setName(resume.displayName);
              setNameError(null);
              setMode("rename");
            }}
          >
            Rename
          </button>
          <button type="button" className="btn-link btn-link-danger" aria-label={`Delete ${resume.displayName}`} onClick={() => setMode("delete")}>
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

export function ResumesPanel() {
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let live = true;
    api.listResumes().then(
      (r) => live && setResumes(r),
      (err) => live && setError(err instanceof ApiError ? err.message : "Could not load the resumes."),
    );
    return () => {
      live = false;
    };
  }, [tick]);

  return (
    <div className="resumes">
      {error && (
        <p className="callout callout-danger" role="alert">
          {error}
        </p>
      )}
      {resumes === null ? (
        !error && <p className="muted">Loading…</p>
      ) : resumes.length === 0 ? (
        <p className="muted">No resumes yet. Upload a PDF below; the default one is attached to every email.</p>
      ) : (
        <ul className="resume-list">
          {resumes.map((r) => (
            <ResumeItem key={r.id} resume={r} onChanged={reload} onError={setError} />
          ))}
        </ul>
      )}
      <UploadForm onUploaded={reload} />
    </div>
  );
}
