import * as React from "react"
import { Separator as SeparatorPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        // No `self-stretch` here: with an explicit height (every caller sets
        // one) flexbox resolves stretch to flex-start, pinning the divider to
        // the top of the bar. Rely on the parent's items-center instead.
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
