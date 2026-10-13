import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = ["Upload CSV", "Preview", "Schedule"] as const;

/** Three-step progress: `current` is 1-based; steps before it show a check. `current` 4 means all done. */
export function Stepper({ current, className }: { current: 1 | 2 | 3 | 4; className?: string }) {
  return (
    <nav aria-label="Progress" className={cn("mb-6", className)}>
      <ol className="flex items-center gap-2">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = current > n;
          const active = current === n;
          return (
            <li key={label} className="flex items-center gap-2 not-last:flex-1" aria-current={active ? "step" : undefined}>
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-medium tabular-nums",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-accent-text",
                  !done && !active && "text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : n}
              </span>
              <span className={cn("text-[13px] whitespace-nowrap", active ? "font-medium text-foreground" : "text-muted-foreground")}>
                {label}
                {done && <span className="sr-only"> (done)</span>}
              </span>
              {n < STEPS.length && <span aria-hidden="true" className={cn("h-px flex-1", done ? "bg-primary" : "bg-border")} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
