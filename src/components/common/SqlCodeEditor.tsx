import { sql, MySQL, PostgreSQL, SQLite } from "@codemirror/lang-sql";
import { search, openSearchPanel, searchKeymap } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import type { SqlDialect } from "@/types/ipc";

/**
 * Shared SQL editing surface (Phase 4): the chrome theme and MySQL dialect
 * setup extracted from the query editor's SqlEditor so object code editors
 * and read-only DDL views render identically.
 *
 * Phase 9-B: find & replace via @codemirror/search is part of the shared
 * config — Ctrl/Cmd+F opens the panel (with its replace field), Escape
 * closes; regex/case toggles are built in. The global shortcuts registry
 * does NOT claim Mod+F, so no conflict arises.
 */

/** Monospace stack mirroring Tailwind's `font-mono` (Geist Mono first). */
export const MONO_STACK =
  "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";

export const sqlChromeTheme = EditorView.theme({
  "&": {
    fontSize: "12.5px",
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: MONO_STACK,
    lineHeight: "1.55",
  },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklab, var(--muted) 40%, transparent)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--accent) 35%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--accent) 50%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)!",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
  },
  // Find & replace panel (Phase 9-B): hook the panel chrome into the shadcn
  // CSS variables so light/dark follow the app theme next to oneDark.
  ".cm-panel.cm-search": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    fontFamily: "var(--font-sans, inherit)",
    fontSize: "11.5px",
    padding: "4px 8px",
  },
  ".cm-panel.cm-search label": {
    color: "var(--muted-foreground)",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    borderRadius: "calc(var(--radius) - 4px)",
    border: "1px solid var(--border)",
    background: "var(--background)",
    color: "var(--foreground)",
    padding: "1px 5px",
    fontSize: "11.5px",
  },
  ".cm-panel.cm-search button:hover": {
    background: "var(--accent)",
  },
  ".cm-panel.cm-search input[name=search]": {
    color: "var(--popover-foreground)",
  },
});

/** Map the wire dialect to the CodeMirror SQL dialect. */
export function dialectToLang(dialect: SqlDialect | undefined) {
  switch (dialect) {
    case "postgres":
      return PostgreSQL;
    case "sqlite":
      return SQLite;
    default:
      return MySQL;
  }
}

/** Map the wire dialect to sql-formatter's language names. */
export function dialectToFormatterLanguage(dialect: SqlDialect | undefined) {
  switch (dialect) {
    case "postgres":
      return "postgresql" as const;
    case "sqlite":
      return "sqlite" as const;
    default:
      return "mysql" as const;
  }
}

/**
 * Shared find & replace extensions (Phase 9-B): `search({ top: true })`
 * renders the builtin panel above the code; the keymap brings Ctrl/Cmd+F,
 * Enter/F3 cycling, and Escape-to-close. A high-precedence extra binding
 * maps Ctrl/Cmd+H (and Cmd+Alt+F on macOS) to opening the same panel with
 * focus on its replace field.
 */
export function createSearchExtensions() {
  const openWithReplace = (view: EditorView): boolean => {
    if (!openSearchPanel(view)) return true;
    // Focus the replace input once the panel exists in the DOM.
    window.setTimeout(() => {
      const fields = view.dom.querySelectorAll<HTMLInputElement>(
        ".cm-panel.cm-search input[name=replace]",
      );
      fields[0]?.focus();
      fields[0]?.select();
    }, 0);
    return true;
  };

  return [
    search({ top: true }),
    keymap.of(searchKeymap),
    Prec.high(
      keymap.of([
        { key: "Mod-h", run: openWithReplace },
        { key: "Mod-Alt-f", run: openWithReplace },
      ]),
    ),
  ];
}

export interface SqlCodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  theme: "dark" | "light";
  /** `{ tableName: [column, ...] }`; empty for plain keyword completion. */
  schema?: Record<string, string[]>;
  readOnly?: boolean;
  placeholder?: string;
  /** SQL family for highlighting/completion (defaults to MySQL). */
  dialect?: SqlDialect;
  /** Disable the find & replace panel (tiny embedded editors). */
  disableSearch?: boolean;
}

/**
 * CodeMirror configured for SQL without run-shortcut keymaps. Read-only
 * mode disables editing, completion and active-line highlights (DDL views).
 */
export function SqlCodeEditor({
  value,
  onChange,
  theme,
  schema,
  readOnly = false,
  placeholder,
  dialect,
  disableSearch = false,
}: SqlCodeEditorProps) {
  const language = useMemo(
    () =>
      sql({
        dialect: dialectToLang(dialect),
        upperCaseKeywords: true,
        schema: schema ?? {},
      }),
    [schema, dialect],
  );

  const searchExtensions = useMemo(
    () => (disableSearch ? [] : createSearchExtensions()),
    [disableSearch],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height="100%"
      style={{ height: "100%" }}
      theme={theme === "dark" ? [oneDark, sqlChromeTheme] : sqlChromeTheme}
      extensions={[language, ...searchExtensions]}
      editable={!readOnly}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: !readOnly,
        foldGutter: false,
        autocompletion: !readOnly,
        bracketMatching: true,
        closeBrackets: !readOnly,
        highlightSelectionMatches: false,
      }}
      placeholder={placeholder}
    />
  );
}
