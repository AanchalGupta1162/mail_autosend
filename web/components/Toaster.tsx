"use client";

import { useEffect, useSyncExternalStore } from "react";
import { CircleCheck, Info, OctagonAlert, X } from "lucide-react";
import { dismiss, getToasts, subscribe, type ToastItem, type ToastKind } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ICON: Record<ToastKind, { icon: typeof Info; tone: string }> = {
  success: { icon: CircleCheck, tone: "text-st-green" },
  error: { icon: OctagonAlert, tone: "text-st-red" },
  info: { icon: Info, tone: "text-st-indigo" },
};

const EMPTY: ToastItem[] = [];

function Item({ t }: { t: ToastItem }) {
  useEffect(() => {
    const h = window.setTimeout(() => dismiss(t.id), t.kind === "error" ? 8000 : 4000);
    return () => window.clearTimeout(h);
  }, [t.id, t.kind]);
  const { icon: Icon, tone } = ICON[t.kind];
  return (
    <li
      role={t.kind === "error" ? "alert" : "status"}
      className="pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border bg-popover px-3.5 py-3 text-[13px] text-popover-foreground shadow-pop animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <p className="min-w-0 flex-1 leading-5">{t.message}</p>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="-mr-1 rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </li>
  );
}

export function Toaster() {
  const items = useSyncExternalStore(subscribe, getToasts, () => EMPTY);
  return (
    <ol aria-label="Notifications" className="pointer-events-none fixed right-4 bottom-4 left-4 z-[70] flex flex-col gap-2 sm:left-auto sm:w-80">
      {items.map((t) => (
        <Item key={t.id} t={t} />
      ))}
    </ol>
  );
}
