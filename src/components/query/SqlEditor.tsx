import { sql } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";

import {
  createSearchExtensions,
  dialectToLang,
  oneDarkSyntax,
  sqlChromeTheme,
} from "@/components/common/SqlCodeEditor";
import type { SqlDialect } from "@/types/ipc";

/**
 * SQL editing surface for query tabs: MySQL dialect highlighting,
 * schema-driven completion fed by the live connection metadata, and
 * run-shortcut keymaps. Styling hooks into the shadcn CSS variables so
 * light/dark follows the app theme (shared with the object editors via
 * `components/common/SqlCodeEditor`).
 */

/** What part of the document the user asked to execute. */
export type RunRequestKind =
  /** Whole editor contents (F9 / F5 / Run button). */
  | "all"
  /** Active selection, falling back to everything (Ctrl/Cmd+Enter). */
  | "selection";

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  theme: "dark" | "light";
  /** `{ tableName: [column, ...] }`; entries with empty arrays still give table-name completion. */
  schema: Record<string, string[]>;
  onRequestRun: (kind: RunRequestKind) => void;
  onViewReady?: (view: EditorView) => void;
  /** SQL family of the connection (defaults to MySQL). */
  dialect?: SqlDialect;
}

export function SqlEditor({
  value,
  onChange,
  theme,
  schema,
  onRequestRun,
  onViewReady,
  dialect,
}: SqlEditorProps) {
  // Theme-aware chrome: One Dark token colors on top, app-variable surfaces
  // underneath (stable module-level instances, so identity only changes when
  // the theme flips).
  const chromeTheme = sqlChromeTheme(theme === "dark");

  // Latest run-request handler without rebuilding the keymap on every render.
  const runRef = useRef(onRequestRun);
  runRef.current = onRequestRun;

  const readyRef = useRef(onViewReady);
  readyRef.current = onViewReady;

  const runKeys = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "F9",
            preventDefault: true,
            run: () => {
              runRef.current("all");
              return true;
            },
          },
          {
            key: "F5",
            preventDefault: true,
            run: () => {
              runRef.current("all");
              return true;
            },
          },
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              runRef.current("selection");
              return true;
            },
          },
        ]),
      ),
    [],
  );

  // Recreated only when the catalog shape or dialect changes; lang-sql turns
  // this into keyword + table/column completion for the active engine.
  const language = useMemo(
    () => sql({ dialect: dialectToLang(dialect), upperCaseKeywords: true, schema }),
    [schema, dialect],
  );

  const extensions = useMemo(
    () => [language, runKeys, ...createSearchExtensions(), chromeTheme],
    [language, runKeys, chromeTheme],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height="100%"
      style={{ height: "100%" }}
      theme={theme === "dark" ? [oneDarkSyntax, chromeTheme] : chromeTheme}
      extensions={extensions}
      onCreateEditor={(view) => readyRef.current?.(view)}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        foldGutter: false,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        highlightSelectionMatches: false,
      }}
      placeholder="Type SQL here…  (F9 runs everything, Ctrl+Enter runs the selection)"
    />
  );
}
