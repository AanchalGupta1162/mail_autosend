import { cn } from "@/lib/utils";

/** A quiet inline action (used in dense rows). Renders a real <button>. */
export function TextButton({ className, danger, ...props }: React.ComponentProps<"button"> & { danger?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "rounded-sm text-xs font-medium whitespace-nowrap underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50",
        danger ? "text-destructive" : "text-accent-text",
        className,
      )}
    />
  );
}
