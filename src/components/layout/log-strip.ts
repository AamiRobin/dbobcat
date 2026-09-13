/**
 * Geometry of the collapsible log panel, shared so the pieces can't drift:
 * the collapsed strip is exactly MessageLog's header row, and the collapse
 * detector in App.tsx needs the same height in pixels. 1.75rem = h-7 = 28px.
 */
export const LOG_HEADER_REM = "1.75rem";
/** Header height plus slack, so an expanded panel at minSize never reads as collapsed. */
export const LOG_COLLAPSED_THRESHOLD_PX = 32;
