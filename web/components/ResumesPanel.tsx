"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { FileText, Loader2, Upload } from "lucide-react";
import { toast } from "@/lib/toast";
import { api, ApiError } from "@/lib/api";
import { plural } from "@/lib/format";
import { checkResumeFile, checkResumeName, defaultNameFor, formatBytes, looksLikePdf } from "@/lib/resumes";
import type { Resume } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Notice } from "./Notice";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  const [dragging, setDragging] = useState(false);

  function pick(f: File | undefined) {
    setFile(f ?? null);
    setError(null);
    if (f && (name === "" || name === suggested)) {
      const s = defaultNameFor(f.name);
      setSuggested(s);
      setName(s);
    }
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (input.current) {
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        input.current.files = dt.files;
      } catch {
        // Older browsers: the file is still tracked in state below.
      }
    }
    pick(f);
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
      toast.success("Resume uploaded");
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <label
        htmlFor="resume-file"
        className={cn(
          "group flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
          "hover:border-primary/60 hover:bg-accent/50 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25",
          dragging && "border-primary bg-accent",
          file && "border-solid bg-muted/50",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input id="resume-file" ref={input} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(e) => pick(e.target.files?.[0])} />
        {file ? <FileText aria-hidden="true" className="size-5 text-accent-text" /> : <Upload aria-hidden="true" className="size-5 text-muted-foreground group-hover:text-foreground" />}
        <span className="text-[13px] font-medium">Resume file (PDF, up to 5 MB)</span>
        <span className="text-xs text-muted-foreground">{file ? `${file.name} · ${formatBytes(file.size)}` : "Drop a PDF here or click to choose"}</span>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="resume-name">Display name</Label>
        <Input id="resume-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Backend roles" />
        <p className="text-xs text-muted-foreground">Shown when you choose which resume to attach.</p>
      </div>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Uploading…" : "Upload resume"}
        </Button>
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
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium">{resume.displayName}</span>
            {resume.isDefault && <span className="rounded-md bg-st-green-bg px-1.5 py-0.5 text-[11px] font-medium text-st-green">Default</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono">{resume.fileName}</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(resume.sizeBytes)}</span>
            {inUse.map((t) => (
              <span key={t} className="before:mr-2 before:content-['·']">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
      {mode === "rename" ? (
        <form className="flex w-full flex-wrap items-start gap-2 sm:w-auto" onSubmit={saveName} noValidate>
          <label className="sr-only" htmlFor={`rn-${resume.id}`}>
            New name for {resume.displayName}
          </label>
          <div className="flex-1 sm:w-52">
            <Input id={`rn-${resume.id}`} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameError ? true : undefined} />
            {nameError && <p className="mt-1 text-xs text-destructive">{nameError}</p>}
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            Save name
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setMode("view")}>
            Keep
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-1">
          {!resume.isDefault && (
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Make ${resume.displayName} the default`} onClick={() => run(() => api.updateResume(resume.id, { isDefault: true }))}>
              Make default
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Rename ${resume.displayName}`}
            onClick={() => {
              setName(resume.displayName);
              setNameError(null);
              setMode("rename");
            }}
          >
            Rename
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" aria-label={`Delete ${resume.displayName}`} onClick={() => setMode("delete")}>
            Delete
          </Button>
        </div>
      )}
      <AlertDialog open={mode === "delete"} onOpenChange={(o) => !o && setMode("view")}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {resume.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>Delete this resume? Emails already sent are not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run(() => api.deleteResume(resume.id));
              }}
            >
              Delete resume
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <div className="space-y-5">
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {resumes === null ? (
        !error && <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : resumes.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-5 text-center text-[13px] text-muted-foreground">No resumes yet. Upload a PDF below; the default one is attached to every email.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {resumes.map((r) => (
            <ResumeItem key={r.id} resume={r} onChanged={reload} onError={setError} />
          ))}
        </ul>
      )}
      <UploadForm onUploaded={reload} />
    </div>
  );
}
