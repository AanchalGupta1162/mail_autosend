import { cn } from "@/lib/utils";

/** Plain-text email preview: the API never sends HTML, and markup is never injected. */
export function EmailLetter({ label, to, subject, attachment, body, className }: { label: string; to?: string; subject: string; attachment?: string | null; body: string; className?: string }) {
  return (
    <article aria-label={label} className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <dl className="space-y-1 border-b bg-muted/50 px-4 py-2.5 text-[13px]">
        {to && (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted-foreground">To</dt>
            <dd className="min-w-0 truncate font-mono text-xs leading-5">{to}</dd>
          </div>
        )}
        <div className="flex gap-3">
          <dt className="w-16 shrink-0 text-muted-foreground">Subject</dt>
          <dd className="min-w-0 font-medium">{subject}</dd>
        </div>
        {attachment && (
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted-foreground">Attachment</dt>
            <dd className="min-w-0">{attachment}</dd>
          </div>
        )}
      </dl>
      <pre className="max-h-72 overflow-auto px-4 py-3 font-sans text-[13px] leading-6 whitespace-pre-wrap">{body}</pre>
    </article>
  );
}

/** Rows of "label · detail" lines inside a Notice. */
export function IssueList({ children }: { children: React.ReactNode }) {
  return <ul className="max-h-60 space-y-1 overflow-y-auto pt-1 [&>li]:flex [&>li]:flex-wrap [&>li]:items-baseline [&>li]:gap-x-3">{children}</ul>;
}
