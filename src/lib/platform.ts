/**
 * Coarse platform detection from the user agent. The Tauri webviews report
 * their host OS (WKWebView → "Macintosh", WebView2 → "Windows NT",
 * WebKitGTK → "X11; Linux"), and a plain browser preview reports the real
 * host — so these are only used for chrome that differs per OS, never for
 * feature gating.
 */
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const isMac = /Mac/i.test(ua);
export const isWindows = /Windows/i.test(ua);
export const isLinux = !isMac && !isWindows && /Linux|X11/i.test(ua);

/** Running inside the Tauri shell (false in a plain browser preview). */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Frameless shell: the app header owns the window controls (Windows-style,
 * right side). macOS keeps the native traffic lights on the left instead.
 */
export const usesInAppWindowControls = !isMac && isTauri;
