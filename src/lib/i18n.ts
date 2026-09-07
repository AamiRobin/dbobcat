/**
 * Minimal typed i18n (Phase 8 groundwork).
 *
 * Design goals:
 * - No runtime dependency: a plain dictionary + `t()` with `{var}` slots.
 * - Type safety: `TKey` is derived from the `en` dictionary, so a missing or
 *   misspelled key is a compile error.
 * - Extensible: adding a language means adding a dictionary entry plus
 *   wiring it into `LANGUAGES`; the UI language lives in the ui store
 *   (persisted like the theme).
 *
 * Coverage (P8): app chrome — toolbar, tabs bar, status bar, session
 * manager (+ form), common dialogs (confirm/find-text/shortcuts/about).
 * Deep extraction of data-grid / designer / export-import internals is
 * deliberately deferred; those components still use literal strings.
 */

export const en = {
  // App shell
  "app.name": "DBobcat",

  // Toolbar
  "toolbar.connect": "Connect",
  "toolbar.newQuery": "New Query",
  "toolbar.refresh": "Refresh",
  "toolbar.import": "Import",
  "toolbar.importHint": "Import CSV / text file",
  "toolbar.users": "User manager",
  "toolbar.processes": "Process list",
  "toolbar.variables": "Variables & status",
  "toolbar.findText": "Find text on server",
  "toolbar.findTextHint": "Find text on server (Ctrl+Shift+F)",
  "toolbar.toggleTheme": "Toggle theme",

  // Tabs bar
  "tabs.newTab": "New tab",
  "tabs.newTabHint": "New tab",
  "tabs.newQuery": "New Query Tab",
  "tabs.newData": "New Data Tab",
  "tabs.newDesigner": "New Designer Tab",
  "tabs.close": "Close tab",

  // Status bar
  "status.notConnected": "Not connected",
  "status.connecting": "Connecting…",
  "status.rows": "Rows:",
  "status.elapsed": "Elapsed:",
  "status.executing": "Executing…",
  "status.reconnecting": "Reconnecting…",
  "status.linkLost": "Connection lost",

  // Transaction chip + ledger popover (Transactions UI Phase 1)
  "tx.chip.auto": "Auto",
  "tx.chip.manualIdle": "Manual",
  "tx.chip.manualOpen": "Manual · {count}",
  "tx.chip.aborted": "Aborted",
  "tx.chip.title": "Transactions",
  "tx.popover.empty":
    "No statements tracked yet. Statements run on this connection appear here while a transaction is open.",
  "tx.popover.commit": "Commit",
  "tx.popover.rollback": "Rollback",
  "tx.popover.isolation": "Isolation",
  "tx.popover.mode": "Manual transactions",
  "tx.popover.modeHint": "New statements run inside an explicit transaction.",
  "tx.popover.rowsAffected": "{count} row(s)",
  "tx.footer.note": "Tracking DBobcat-issued statements.",
  "tx.isolation.readUncommitted": "Read uncommitted",
  "tx.isolation.readCommitted": "Read committed",
  "tx.isolation.repeatableRead": "Repeatable read",
  "tx.isolation.serializable": "Serializable",
  "tx.toast.modeSwitchRefused":
    "Commit or roll back the open transaction before switching to auto-commit.",
  "tx.toast.committed": "Transaction committed — {count} statement(s) cleared.",
  "tx.toast.rolledBack": "Transaction rolled back — {count} statement(s) cleared.",
  "tx.log.rollbackByDisconnect": "Open transaction was rolled back by disconnect.",
  "tx.dialog.title": "Open transaction",
  "tx.dialog.body":
    "A transaction is open with {count} tracked statement(s). It will be rolled back by the server unless you commit it before {action}.",
  "tx.dialog.action.disconnect": "disconnecting",
  "tx.dialog.action.quit": "quitting",
  "tx.dialog.action.windowClose": "closing the window",
  "tx.dialog.commit": "Commit & proceed",
  "tx.dialog.rollback": "Roll back & proceed",
  "tx.ddlWarning.title": "Statement will commit the transaction",
  "tx.ddlWarning.body":
    "{count} statement(s) in this script are DDL that makes MySQL implicitly commit the open transaction first.",
  "tx.ddlWarning.confirm": "Run anyway",

  // Center panel empty states
  "empty.noTabs.title": "No tabs open",
  "empty.noTabs.hint": "Create a new Query tab to start writing SQL.",
  "empty.connect.title": "Connect to a server",
  "empty.connect.hint":
    "Open the session manager to connect to MySQL, PostgreSQL or SQLite.",
  "empty.connect.button": "Connect to a Server…",
  "empty.newQuery.button": "New Query Tab",

  // Session manager dialog
  "session.title": "Session manager",
  "session.description":
    "Save connection profiles. Passwords are stored encrypted and never leave this machine.",
  "session.list": "Sessions",
  "session.loading": "Loading…",
  "session.new": "New session",
  "session.all": "All sessions",
  "session.delete": "Delete",
  "session.test": "Test connection",
  "session.testing": "Testing connection…",
  "session.save": "Save",
  "session.connect": "Connect",
  "session.saved": "Session “{name}” saved.",

  // Session form fields
  "session.form.name": "Name",
  "session.form.file": "Database file",
  "session.form.browse": "Browse…",
  "session.form.host": "Host",
  "session.form.port": "Port",
  "session.form.user": "User",
  "session.form.password": "Password",
  "session.form.group": "Group",
  "session.form.groupPlaceholder": "Work/Prod",
  "session.form.groupEmpty": "No matching groups",
  "session.form.color": "Color",
  "session.form.comment": "Comment",
  "session.form.commentPlaceholder": "Note shown in the session list",
  "session.form.keepAlive": "Keep-alive (sec)",
  "session.form.keepAliveHint":
    "Ping interval in seconds, 0 disables. If the link drops, the app reconnects silently.",
  "session.form.keepAliveSqliteHint":
    "Keep-alive does not apply to SQLite sessions (local file).",
  "session.form.txMode": "Transactions",
  "session.form.txMode.auto": "Auto",
  "session.form.txMode.manual": "Manual",
  "session.form.txModeHint": "Manual opens an explicit transaction you commit yourself.",
  "session.form.isolation": "Isolation level",
  "session.form.isolation.default": "Server default",
  "session.form.isolationHint": "Applied to the session at connect time.",
  "session.form.passwordHint":
    "Leave the password blank to keep the stored one. Passwords are kept in an encrypted local file, never in the session itself.",
  "session.form.database": "Database",
  "session.form.sslMode": "SSL mode",
  "session.form.sshTunnel": "SSH tunnel",
  "session.form.sshHint": "Connect through a bastion via local port-forward",
  "session.form.sshHost": "SSH host",
  "session.form.sshUser": "SSH user",
  "session.form.auth": "Authentication",
  "session.form.sshPassword": "SSH password",
  "session.form.keyPath": "Private key path",
  "session.form.passphrase": "Key passphrase",
  "session.form.engine.server": "Server",
  "session.form.engine.file": "File",
  "session.form.sqliteHint":
    "SQLite sessions open a local database file. Server options (host, credentials, SSH, SSL) do not apply.",
  "session.form.useSshTunnel": "Use SSH tunnel",
  "session.form.ssl.disabled": "Disabled",
  "session.form.ssl.preferred": "Preferred",
  "session.form.ssl.required": "Required",
  "session.test.connected": "Connected — {version} ({ms}ms)",
  "session.test.unknownVersion": "unknown version",
  "session.test.failed": "Connection failed.",

  // Import wizard (structural labels; prose stays literal by design)
  "import.step.source": "Source",
  "import.step.parse": "Parse",
  "import.step.target": "Target",
  "import.step.mode": "Mode",
  "import.step.run": "Run",
  "import.parse.delimiter": "Delimiter",
  "import.parse.quote": "Quote",
  "import.parse.header": "First row is header",
  "import.parse.emptyIsNull": "Empty → NULL",
  "import.parse.skipRows": "Skip rows",
  "import.target.database": "database…",
  "import.target.table": "table…",
  "import.map.skip": "(skip)",
  "import.mode.append": "Append",
  "import.mode.replace": "Replace",
  "import.mode.insertIgnore": "Insert ignore",
  "import.mode.upsert": "Upsert",
  "import.mode.append.hint": "plain INSERTs",
  "import.mode.replace.hint": "TRUNCATE the target first",
  "import.mode.insertIgnore.hint": "skip duplicate-key rows",
  "import.mode.upsert.hint": "update non-PK columns on duplicate key",
  "import.run.batchSize": "Batch size",
  "import.run.onError": "On error",
  "import.onError.abort": "Abort",
  "import.onError.skip": "Skip batch",
  "import.onError.through": "Retry rows individually",

  // Export dialog (dump content switch; remaining prose stays literal)
  "export.dump.what.structureAndData": "Structure + data",
  "export.dump.what.structure": "Structure only",
  "export.dump.what.data": "Data only",

  // Confirm dialog
  "dialog.cancel": "Cancel",
  "dialog.close": "Close",

  // Find-text dialog
  "find.title": "Find text on server",
  "find.description":
    "Scan string columns across databases. Regex runs on MySQL only.",
  "find.placeholder": "Text to find…",
  "find.run": "Run",
  "find.cancel": "Cancel",
  "find.mode": "Mode",
  "find.mode.contains": "Contains",
  "find.mode.prefix": "Prefix",
  "find.mode.whole": "Whole value",
  "find.mode.regex": "Regex (MySQL only)",
  "find.options": "Options",
  "find.caseSensitive": "Case sensitive",
  "find.maxPerTable": "Max/table",
  "find.databases": "Databases ({count})",
  "find.tables": "Tables (optional)",
  "find.restrict": "restrict",
  "find.toggleAll": "toggle all",
  "find.allTables": "Every base table of each selected database.",
  "find.scanning": "Scanning… {done}/{total} tables",
  "find.cancelled": "Cancelled",
  "find.done": "Done",
  "find.matchCount": "{count} match(es)",
  "find.noMatches": "No matches found.",
  "find.runFirst": "Run a search to see matches here.",
  "find.col.db": "DB",
  "find.col.table": "Table",
  "find.col.column": "Column",
  "find.col.pk": "PK",
  "find.col.preview": "Preview",

  // Shortcuts dialog
  "shortcuts.title": "Keyboard shortcuts",
  "shortcuts.description":
    "Fixed bindings for now; the registry is designed for remapping later.",

  // About dialog
  "about.title": "About DBobcat",
  "about.tagline":
    "An open-source database GUI client for MySQL/MariaDB, PostgreSQL and SQLite.",
  "about.license": "Released under the MIT license.",
  "about.credits": "Inspired by HeidiSQL — thanks for a decade of ideas.",
  "about.repository": "Project homepage",

  // Action-feedback toasts (sonner)
  "toast.copied": "Copied “{name}” to clipboard",
  "toast.export.finished": "Export finished — {bytes} written to {file}",
  "toast.export.failed": "Export failed",
  "toast.changes.posted": "{count} change(s) applied to {table}",
  "toast.import.finished": "Import finished — {inserted} row(s) inserted",
  "toast.import.failed": "Import failed",
  "toast.table.created": "Table “{table}” created.",
  "toast.table.altered": "Table “{table}” altered.",

  // Grid power features (Phase 9-A)
  "grid.quickFilter": "Quick filter",  "grid.quickFilter.byClipboard": "Filter by clipboard value",
  "grid.quickFilter.moreValues": "More values…",
  "grid.distinct.title": "Values in “{column}”",
  "grid.distinct.searchPlaceholder": "Filter values…",
  "grid.distinct.selectAll": "Select all",
  "grid.distinct.value": "Value",
  "grid.distinct.count": "Count",
  "grid.distinct.loading": "Loading values…",
  "grid.distinct.none": "No values match.",
  "grid.distinct.apply": "Apply IN filter ({count})",
  "grid.copyAs": "Copy as",
  "grid.copyAs.insert": "INSERT statement(s)",
  "grid.copyAs.replace": "REPLACE statement(s)",
  "grid.copyAs.update": "UPDATE statement(s)",
  "grid.copyAs.updateNeedsPk":
    "UPDATE needs primary-key columns plus another column in the grid",
  "grid.pasteRows": "Paste rows (TSV)",
  "grid.pasted.rows": "Staged {count} row(s) for insert — review and Post changes.",
  "grid.pasted.mismatch":
    "Clipboard has {clipboardCols} column(s), the grid shows {gridCols}. Nothing pasted.",
  "grid.fk.pickValue": "Referenced values",
  "grid.fk.setNull": "Set NULL",
  "grid.fk.empty": "No referenced rows.",
  "grid.fk.goTo": "Go to",
  "grid.fk.goToRef": "Referenced row in {table}",
  "grid.fk.goToComposite": "{table} ({count} columns)",
  "grid.fk.nullCell": "cell is NULL",
  "grid.fk.constraint": "{name}",
  "grid.fk.referencing": "Rows referencing this row",
  "grid.fk.referencingItem": "{table}.{column}",
  "grid.fk.noRefs": "No referencing rows.",
  "grid.fk.loadingRefs": "Looking up…",
  "grid.fk.jumpGlyph": "Open referenced row in {table}",
  "query.editable.postChanges": "Post changes",
  "query.editable.discard": "Discard",
  "query.editable.noTable":
    "Editing unavailable — the result set does not map to exactly one table.",
  "query.editable.noPk":
    "Editing unavailable — include the primary key column(s) in the SELECT list.",
  "query.editable.posted":
    "{count} change(s) applied to {db}.{table} — re-run the query to refresh.",

  // DB tree (Phase 9-B)
  "tree.filterPlaceholder": "Filter (regex ok)…",
  "tree.filterLabel": "Filter tree",
  "tree.filterHint": "Substring or regular expression — matches databases and objects.",
  "tree.filterClear": "Clear filter",
  "tree.favoritesOnly": "Favorites only",
  "tree.favorite.add": "Toggle favorite",
  "tree.favorite.remove": "Toggle favorite",
  "tree.toggleColumns": "Toggle columns",
  "tree.noMatches": "No databases or objects match the filter.",
  "tree.noFavorites": "No favorites yet — star tables in the tree.",
  "tree.sessionAccent": "Session color",
  "tree.copyTable": "Create table copy…",
  "tree.copyTable.title": "Create table copy",
  "tree.copyTable.source": "Source:",
  "tree.copyTable.targetDb": "Target database",
  "tree.copyTable.targetName": "Target table name",
  "tree.copyTable.content": "Content",
  "tree.copyTable.structure": "Structure only",
  "tree.copyTable.structureData": "Structure + data",
  "tree.copyTable.indexes": "Copy indexes (primary key always)",
  "tree.copyTable.fks": "Copy foreign keys",
  "tree.copyTable.create": "Create copy",
  "tree.copyTable.exists": "A table with this name already exists.",
  "tree.copyTable.sameOnly": "Cross-database copies are MySQL-only.",
  "tree.copyTable.hint":
    "Runs on this connection. To copy to another server, use Export → SQL dump instead.",
  "tree.copyTable.done": "Copied {count} row(s) into {table}.",

  // Command palette
  "toolbar.palette": "Command palette",
  "palette.title": "Command palette",
  "palette.description": "Search actions, sessions, objects and query history",
  "palette.placeholder":
    "Search actions, sessions, tables… (> commands, @ sessions, # history, db: database)",
  "palette.placeholderCommands": "Type a command…",
  "palette.placeholderHistory": "Search executed queries…",
  "palette.placeholderDb": "Filter objects by database…",
  "palette.section.commands": "Commands",
  "palette.section.sessions": "Sessions",
  "palette.section.recents": "Recents",
  "palette.section.tables": "Tables",
  "palette.section.views": "Views",
  "palette.section.routines": "Routines",
  "palette.section.triggers": "Triggers",
  "palette.section.events": "Events",
  "palette.section.columns": "Columns",
  "palette.section.history": "Query history",
  "palette.noResults": "No results. Start with > for commands or @ for sessions.",
  "palette.refine": "{count} more hidden — keep typing to narrow it down",
  "palette.notConnectedHint": "Not connected — pick a session or open the session manager.",
  "palette.hints":
    "↑↓ navigate · ↵ open · ⇧↵ alternate · Tab switch mode · > @ # db: scope · Esc close",
  "palette.copySql": "SQL copied to clipboard",
  "palette.action.newQuery": "New query tab",
  "palette.action.sessionManager": "Open session manager",
  "palette.action.connect": "Connect to a server…",
  "palette.action.disconnect": "Disconnect active session",
  "palette.action.refreshTree": "Refresh database tree",
  "palette.action.toggleTheme": "Toggle light/dark theme",
  "palette.action.systemTheme": "Follow system theme (auto)",
  "palette.action.userManager": "User manager",
  "palette.action.processList": "Process list",
  "palette.action.variables": "Variables & status",
  "palette.action.export": "Export database as SQL…",
  "palette.action.import": "Import CSV / text file…",
  "palette.action.findText": "Find text on server",
  "palette.action.erDiagram": "View ER diagram",
  "palette.action.erDiagramPickDb":
    "Several databases on this server — pick one in the tree to view its ER diagram.",
  "palette.action.shortcuts": "Keyboard shortcuts",
  "palette.action.about": "About DBobcat",

  // ER diagram (Phase 11)
  "er.toolbar.fit": "Fit to view",
  "er.toolbar.relayout": "Re-arrange layout",
  "er.toolbar.keysAll": "All columns",
  "er.toolbar.keysOnly": "Keys only",
  "er.toolbar.collapseAll": "Collapse all",
  "er.toolbar.expandAll": "Expand all",
  "er.toolbar.export": "Export",
  "er.toolbar.exportPng": "PNG image (2×)…",
  "er.toolbar.exportSvg": "SVG file…",
  "er.toolbar.copyImage": "Copy image",
  "er.toolbar.refresh": "Refresh diagram",
  "er.status.tables": "{t} tables · {r} relations",
  "er.status.crossDb": "{count} cross-database reference(s) not shown",
  "er.status.hidden": "{count} hidden — show",
  "er.empty.noTables.title": "No tables in this database",
  "er.empty.noTables.hint":
    "This database has no base tables yet. Create one with the table designer.",
  "er.empty.noFks": "No foreign keys declared — showing unrelated tables.",
  "er.error.title": "Could not load the diagram",
  "er.error.retry": "Retry",
  "er.toast.exported": "Diagram exported → {file}",
  "er.toast.copiedImage": "Diagram copied to clipboard",
  "er.toast.copyUnavailable": "Clipboard images are unavailable here",
  "er.toast.copyFailed": "Copy failed: {message}",
  "er.export.existsTitle": "File already exists",
  "er.export.existsBody": "“{file}” exists. Overwrite?",
  "er.export.overwrite": "Overwrite",

  // Query helpers panel (Phase 9-B)
  "helpers.open": "Query helpers",
  "helpers.columns": "Columns",
  "helpers.snippets": "Snippets",
  "helpers.reference": "Reference",
  "helpers.table": "Table",
  "helpers.searchTable": "Search tables…",
  "helpers.noTables": "No tables match.",
  "helpers.pickTable": "Pick a table to list its columns.",
  "helpers.generateSelect": "SELECT",
  "helpers.generateInsert": "INSERT",
  "helpers.generateUpdate": "UPDATE",
  "helpers.generateDelete": "DELETE",
  "helpers.saveSelection": "Save selection as snippet",
  "helpers.snippetName": "Snippet name",
  "helpers.snippetNamePlaceholder": "e.g. paginate-100",
  "helpers.snippetsEmpty": "No snippets yet. Select SQL in the editor and save it.",
  "helpers.insertAtCursor": "Insert at cursor",
  "helpers.copySnippet": "Copy",
  "helpers.deleteSnippet": "Delete snippet?",
  "helpers.deleteSnippetBody": "“{name}” will be removed from saved snippets.",
  "helpers.save": "Save",
  "helpers.keywordsTitle": "Click a keyword to insert it",
} as const;

export type TKey = keyof typeof en;
export type Lang = keyof typeof LANGUAGES;

/** Registry of available dictionaries; `en` is the reference/fallback. */
export const LANGUAGES = { en } as const;

type Dictionary = Record<TKey, string>;

const dictionaries: Record<Lang, Dictionary> = { en };

let currentLang: Lang = "en";

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  currentLang = lang;
}

/**
 * Translate `key` in the active language, interpolating `{var}` slots.
 * Falls back to the English string when a dictionary is missing an entry.
 */
export function t(key: TKey, vars?: Record<string, string | number>): string {
  const dict = dictionaries[currentLang] ?? dictionaries.en;
  let text: string = dict[key] ?? en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
