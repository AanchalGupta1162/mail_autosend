"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { checkCsvFile, MAX_ROWS } from "@/lib/upload";
import { plural } from "@/lib/format";
import type { Resume, RowIssue, SendWindowInfo, UploadResult } from "@/lib/types";
import { FileSpreadsheet, Loader2, RotateCcw, Upload as UploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { BatchScheduler } from "./BatchScheduler";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { Stepper } from "./Stepper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function UploadView() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<RowIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);

  const [sendWindow, setSendWindow] = useState<SendWindowInfo | null>(null);

  useEffect(() => {
    api.listResumes().then(setResumes, () => {});
    api.getSendWindow().then(setSendWindow, () => {});
  }, []);

  function pick(f: File | undefined | null) {
    setRowErrors([]);
    if (!f) return;
    const problem = checkCsvFile(f);
    setError(problem);
    setFile(problem ? null : f);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  }

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setRowErrors([]);
    try {
      setResult(await api.uploadBatch(file, name));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setRowErrors(err.rowErrors ?? []);
      } else setError("Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null);
    setFile(null);
    setName("");
    setError(null);
    setRowErrors([]);
    if (input.current) input.current.value = "";
  }

  if (result) {
    return (
      <div>
        <PageHeader
          eyebrow="Batch uploaded"
          title={result.batch.name}
          description={
            <>
              {plural(result.contacts.length, "contact")} imported
              {result.errors.length > 0 && `, ${plural(result.errors.length, "row")} rejected`}. Nothing is scheduled until you confirm below.
            </>
          }
          actions={
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw />
              Upload another file
            </Button>
          }
        />
        <BatchScheduler upload={result} resumes={resumes} sendWindow={sendWindow} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Upload a CSV"
        description={`Columns: Company, Role, Person, Email, Subject, Mail Text, and optionally Follow-up Text. Up to ${MAX_ROWS} rows, 1 MB.`}
      />
      <Stepper current={1} />

      <div className="space-y-5 rounded-lg border bg-card p-5">
        <label
          className={cn(
            "group flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
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
          <input ref={input} className="sr-only" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
          <span className="mb-1 grid size-9 place-items-center rounded-lg border bg-background text-muted-foreground group-hover:text-foreground">
            {file ? <FileSpreadsheet aria-hidden="true" className="size-4.5" /> : <UploadIcon aria-hidden="true" className="size-4.5" />}
          </span>
          <span className="text-sm font-medium">{file ? file.name : "Drop a CSV here"}</span>
          <span className="text-[13px] text-muted-foreground">{file ? `${(file.size / 1024).toFixed(1)} KB · choose again to replace` : "or click to choose a file"}</span>
        </label>

        <div className="space-y-1.5">
          <Label htmlFor="batch-name">Batch name (optional)</Label>
          <Input id="batch-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the file name" />
        </div>

        {error && (
          <Notice tone="danger" role="alert" title={error}>
            {rowErrors.length > 0 && (
              <ul className="max-h-60 space-y-1 overflow-y-auto pt-1">
                {rowErrors.map((e) => (
                  <li key={e.row} className="flex gap-3">
                    <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">Row {e.row}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        )}

        <div className="flex justify-end">
          <Button disabled={!file || busy} onClick={onUpload}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Uploading…" : "Upload and preview"}
          </Button>
        </div>
      </div>
    </div>
  );
}
