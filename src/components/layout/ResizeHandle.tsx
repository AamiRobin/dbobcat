import { Separator as ResizeSeparator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * Styled divider between resizable panels (react-resizable-panels v4
 * `Separator`). Includes an invisible wider hit-area for easier grabbing.
 */
export function ResizeHandle({
  className,
  direction = "horizontal",
}: {
  className?: string;
  direction?: "horizontal" | "vertical";
}) {
  return (
    <ResizeSeparator
      className={cn(
        // react-resizable-panels v4 sets data-separator to
        // "inactive" | "hover" | "active" | "focus" | "disabled".
        "relative flex items-center justify-center bg-border outline-none transition-colors focus-visible:bg-ring data-[separator=hover]:bg-ring data-[separator=active]:bg-ring",
        direction === "horizontal" ? "w-px" : "h-px",
        className,
      )}
    >
      {/* Wider invisible hit area */}
      <div
        className={
          direction === "horizontal"
            ? "absolute inset-y-0 -left-1 -right-1"
            : "absolute inset-x-0 -top-1 -bottom-1"
        }
      />
    </ResizeSeparator>
  );
}
