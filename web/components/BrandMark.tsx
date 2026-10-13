import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

/** The Outbox mark: a small indigo tile with a paper plane. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.2)]", className)}
    >
      <Send className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}
