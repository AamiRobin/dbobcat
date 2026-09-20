// Render-blocking theme resolution, loaded from index.html <head> before the
// bundle boots. Mirrors resolveTheme()/applyTheme() in src/stores/ui.ts: read
// the persisted preference, follow the OS appearance for "system", and put the
// `dark` class on <html> so the very first paint is already the right theme.
// main.tsx re-applies from the store right after, so any drift self-corrects.
// Plain ES5 and a separate file on purpose: it must run before first paint
// (no defer/module), and the app CSP (`default-src 'self'`) blocks inline
// scripts while same-origin classic scripts load fine.
(function () {
  var pref = "system";
  try {
    var stored = localStorage.getItem("dbobcat.themePref");
    if (stored === "dark" || stored === "light" || stored === "system") {
      pref = stored;
    }
  } catch (e) {
    // storage unavailable (private mode, etc.) — fall through to "system"
  }
  var dark =
    pref === "dark" ||
    (pref === "system" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
