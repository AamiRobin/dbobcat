import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Minimal horizontal stepper for wizards: numbered dots connected by lines,
 * completed steps get a check. Purely presentational.
 */
export function Stepper({
  steps,
  active,
  className,
}: {
  steps: string[];
  /** Zero-based index of the current step. */
  active: number;
  className?: string;
}) {
  return (
    <ol className={cn("flex items-center gap-1 text-[11px]", className)}>
      {steps.map((label, i) => {
        const done = i < active;
        const current = i === active;
        return (
          <li key={label} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span
                className={cn(
                  "mx-1 h-px w-6 shrink-0",
                  done ? "bg-primary" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border font-medium",
                done && "border-primary bg-primary text-primary-foreground",
                current && "border-primary text-primary",
                !done && !current && "border-border text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={cn(
                "truncate",
                current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
