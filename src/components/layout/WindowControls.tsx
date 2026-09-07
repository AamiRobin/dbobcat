import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauri } from "@/lib/platform";
import { cn } from "@/lib/utils";

/**
 * Windows/Linux window controls for the frameless shell: minimize, toggle
 * maximize, close — right side of the app header, Windows style. The glyphs
 * sit flush against the window edge (like native controls) and the close
 * button turns destructive red on hover. Not rendered on macOS (traffic
 * lights) or in a plain browser (no window to control).
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    void win.listen("tauri://resize", sync).then((fn) => {
      unlisten = fn;
      sync();
    });
    return () => unlisten?.();
  }, []);

  // Browser previews render the chrome but the actions no-op without Tauri.
  const run = (action: (win: ReturnType<typeof getCurrentWindow>) => void) => {
    if (isTauri) action(getCurrentWindow());
  };

  const base =
    "flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    // "false" explicitly opts this strip out of the header's drag region —
    // clicks here must never drag the window.
    <div className="-mr-2 flex h-full items-stretch self-stretch" data-tauri-drag-region={false}>
      <button
        type="button"
        aria-label="Minimize"
        className={base}
        onClick={() => run((win) => win.minimize())}
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        className={base}
        onClick={() => run((win) => win.toggleMaximize())}
      >
        {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
      </button>
      <button
        type="button"
        aria-label="Close"
        className={cn(base, "hover:bg-destructive hover:text-destructive-foreground")}
        onClick={() => run((win) => win.close())}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
