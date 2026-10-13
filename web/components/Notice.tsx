import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "danger" | "warning" | "success" | "info";

const STYLE: Record<Tone, { box: string; title: string; icon: typeof Info }> = {
  danger: { box: "border-st-red/25 bg-st-red-bg", title: "text-st-red", icon: OctagonAlert },
  warning: { box: "border-st-amber/30 bg-st-amber-bg", title: "text-st-amber", icon: AlertTriangle },
  success: { box: "border-st-green/25 bg-st-green-bg", title: "text-st-green", icon: CheckCircle2 },
  info: { box: "border-st-indigo/25 bg-st-indigo-bg", title: "text-st-indigo", icon: Info },
};

/** An inline message: tinted surface, hairline border, icon + optional title (never colour alone). */
export function Notice({
  tone,
  title,
  children,
  className,
  ...rest
}: { tone: Tone; title?: React.ReactNode; children?: React.ReactNode } & Omit<React.ComponentProps<"div">, "title">) {
  const s = STYLE[tone];
  const Icon = s.icon;
  return (
    <div {...rest} className={cn("flex gap-2.5 rounded-lg border px-3.5 py-3 text-[13px] leading-5 text-foreground", s.box, className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", s.title)} />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className={cn("font-medium", s.title)}>{title}</p>}
        {children}
      </div>
    </div>
  );
}
