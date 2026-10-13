"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { sendWindowLabel, validateSendWindow, type SendWindowErrors } from "@/lib/sendWindow";
import type { SendWindowInfo } from "@/lib/types";
import { Notice } from "./Notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SendWindowForm() {
  const [info, setInfo] = useState<SendWindowInfo | null>(null);
  const [draft, setDraft] = useState({ start: "", end: "", tz: "" });
  const [errors, setErrors] = useState<SendWindowErrors>({});
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getSendWindow().then(
      (i) => {
        setInfo(i);
        setDraft(i.window);
      },
      (err) => setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not load the send window." }),
    );
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const v = validateSendWindow(draft);
    setErrors(v);
    if (v.start || v.end || v.tz) return;
    setBusy(true);
    try {
      const saved = await api.saveSendWindow({ start: draft.start, end: draft.end, tz: draft.tz.trim() });
      setInfo(saved);
      setDraft(saved.window);
      setNote({ kind: "ok", text: `Window saved: ${sendWindowLabel(saved.window)}.` });
    } catch (err) {
      setNote({ kind: "err", text: err instanceof ApiError ? err.message : "Could not save the send window." });
    } finally {
      setBusy(false);
    }
  }

  if (!info) return <p className="text-[13px] text-muted-foreground">{note?.text ?? "Loading…"}</p>;

  const field = (id: "start" | "end" | "tz", label: string, props: { placeholder?: string; className?: string }) => (
    <div className={props.className ? `space-y-1.5 ${props.className}` : "space-y-1.5"}>
      <Label htmlFor={`sw-${id}`}>{label}</Label>
      <Input
        id={`sw-${id}`}
        value={draft[id]}
        placeholder={props.placeholder}
        onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
        aria-invalid={errors[id] ? true : undefined}
        aria-describedby={errors[id] ? `sw-${id}-err` : undefined}
        autoComplete="off"
      />
      {errors[id] && (
        <p className="text-xs text-destructive" id={`sw-${id}-err`}>
          {errors[id]}
        </p>
      )}
    </div>
  );

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <p className="text-[13px] text-muted-foreground">
        {info.enforced
          ? "Real emails are only sent inside this window each day; anything due earlier waits for the next one."
          : "Not enforced on this server (development): emails send whenever they are due. Production enforces it."}
      </p>
      <div className="grid gap-4 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]">
        {field("start", "Start", { placeholder: "09:00" })}
        {field("end", "End", { placeholder: "10:00" })}
        {field("tz", "Time zone", { placeholder: "Asia/Kolkata" })}
      </div>
      <p className="text-xs text-muted-foreground">24-hour times. Start is included, end is not.</p>
      {note && (
        <Notice tone={note.kind === "ok" ? "success" : "danger"} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}
        </Notice>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "Saving…" : "Save window"}
        </Button>
      </div>
    </form>
  );
}
