"use client";

import { useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { checkCsvFile, MAX_ROWS } from "@/lib/upload";
import { plural } from "@/lib/format";
import type { RowIssue, UploadResult } from "@/lib/types";
import { BatchScheduler } from "./BatchScheduler";

export function UploadView() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<RowIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

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
      <div className="page">
        <header className="page-head">
          <div>
            <p className="eyebrow">Batch uploaded</p>
            <h1>{result.batch.name}</h1>
            <p className="page-sub">
              {plural(result.contacts.length, "contact")} imported
              {result.errors.length > 0 && `, ${plural(result.errors.length, "row")} rejected`}. Nothing is scheduled until you confirm below.
            </p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={reset}>
            Upload another file
          </button>
        </header>
        <BatchScheduler upload={result} />
      </div>
    );
  }

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Upload a CSV</h1>
          <p className="page-sub">
            Columns: Company, Role, Person, Email, Subject, Mail Text, and optionally Follow-up Text. Up to {MAX_ROWS} rows, 1 MB.
          </p>
        </div>
      </header>

      <label
        className={`dropzone${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input ref={input} className="sr-only" type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} />
        <span className="dropzone-title">{file ? file.name : "Drop a CSV here"}</span>
        <span className="dropzone-sub">{file ? `${(file.size / 1024).toFixed(1)} KB · choose again to replace` : "or click to choose a file"}</span>
      </label>

      <div className="field">
        <label htmlFor="batch-name">Batch name (optional)</label>
        <input id="batch-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the file name" />
      </div>

      {error && (
        <div className="callout callout-danger" role="alert">
          <p className="callout-title">{error}</p>
          {rowErrors.length > 0 && (
            <ul className="issue-list">
              {rowErrors.map((e) => (
                <li key={e.row}>
                  <span className="mono issue-row">Row {e.row}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!file || busy} onClick={onUpload}>
          {busy ? "Uploading…" : "Upload and preview"}
        </button>
      </div>
    </div>
  );
}
