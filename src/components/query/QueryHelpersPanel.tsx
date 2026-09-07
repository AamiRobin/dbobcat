import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Braces, Columns3, Copy, Plus, Scissors, Search, Trash2, Type } from "lucide-react";
import { useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/lib/i18n";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  TREE_STALE_TIME,
  dbKeys,
  fetchColumns,
  fetchTables,
} from "@/lib/db-queries";
import { snippetDelete, snippetSave, useSnippets } from "@/lib/snippet-queries";
import { REFERENCE_GROUPS, REFERENCE_KEYWORDS } from "@/lib/query-reference";
import {
  generateDelete,
  generateInsert,
  generateSelect,
  generateUpdate,
} from "@/lib/query-generate";
import type { SqlDialect } from "@/types/ipc";

/**
 * Right-hand query helpers panel (Phase 9-B): checked-column statement
 * skeletons, saved snippets and a small MySQL-flavored reference. All
 * insertions land at the editor cursor via the `insertText` callback.
 */

interface QueryHelpersPanelProps {
  connId: number;
  dialect: SqlDialect;
  /** Current completion database (shared with the toolbar picker). */
  db: string | null;
  databases: { name: string }[];
  onDbChange: (db: string) => void;
  insertText: (text: string) => void;
  /** Selected editor text for "save selection as snippet". */
  getSelection: () => string;
}

export function QueryHelpersPanel({
  connId,
  dialect,
  db,
  databases,
  onDbChange,
  insertText,
  getSelection,
}: QueryHelpersPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l bg-background">
      <Tabs defaultValue="columns" className="flex h-full min-h-0 gap-0">
        <div className="flex shrink-0 items-center justify-between border-b px-2 py-1">
          <TabsList className="h-6">
            <TabsTrigger value="columns" className="px-2 text-xs">
              <Columns3 data-icon="inline-start" className="size-3!" />
              {t("helpers.columns")}
            </TabsTrigger>
            <TabsTrigger value="snippets" className="px-2 text-xs">
              <Braces data-icon="inline-start" className="size-3!" />
              {t("helpers.snippets")}
            </TabsTrigger>
            <TabsTrigger value="reference" className="px-2 text-xs">
              <BookMarked data-icon="inline-start" className="size-3!" />
              {t("helpers.reference")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="columns" className="min-h-0 flex-1">
          <ColumnsHelper
            connId={connId}
            dialect={dialect}
            db={db}
            databases={databases}
            onDbChange={onDbChange}
            insertText={insertText}
          />
        </TabsContent>
        <TabsContent value="snippets" className="min-h-0 flex-1">
          <SnippetsHelper insertText={insertText} getSelection={getSelection} />
        </TabsContent>
        <TabsContent value="reference" className="min-h-0 flex-1">
          <ReferenceHelper insertText={insertText} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns tab
// ---------------------------------------------------------------------------

function ColumnsHelper({
  connId,
  dialect,
  db,
  databases,
  onDbChange,
  insertText,
}: {
  connId: number;
  dialect: SqlDialect;
  db: string | null;
  databases: { name: string }[];
  onDbChange: (db: string) => void;
  insertText: (text: string) => void;
}) {
  const [tableFilter, setTableFilter] = useState("");
  const [table, setTable] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const tables = useQuery({
    queryKey: dbKeys.tables(connId, db ?? ""),
    queryFn: () => fetchTables(connId, db!),
    enabled: connId >= 0 && db !== null,
    staleTime: TREE_STALE_TIME,
  });

  const columns = useQuery({
    queryKey: dbKeys.columns(connId, db ?? "", table ?? ""),
    queryFn: () => fetchColumns(connId, db!, table!),
    enabled: db !== null && table !== null,
    staleTime: TREE_STALE_TIME,
  });

  const filteredTables = useMemo(() => {
    const needle = tableFilter.trim().toLowerCase();
    const names = (tables.data ?? []).map((t) => t.name);
    if (!needle) return names.slice(0, 200);
    return names.filter((n) => n.toLowerCase().includes(needle)).slice(0, 200);
  }, [tables.data, tableFilter]);

  const columnNames = (columns.data ?? []).map((c) => c.name);

  const toggleColumn = (name: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const skeletonInput = {
    db: db ?? "",
    table: table ?? "",
    columns: columnNames.filter((c) => checked.has(c)),
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {/* database + searchable table picker */}
      <div className="grid grid-cols-[110px_1fr] items-center gap-1.5 text-xs">
        <select
          aria-label={t("helpers.table")}
          value={db ?? ""}
          onChange={(e) => {
            onDbChange(e.target.value);
            setTable(null);
            setChecked(new Set());
          }}
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
        >
          {databases.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={tableFilter}
            onChange={(e) => setTableFilter(e.target.value)}
            placeholder={t("helpers.searchTable")}
            className="h-7 pl-6 text-xs"
            aria-label={t("helpers.searchTable")}
          />
        </div>
      </div>

      <ScrollArea className="max-h-36 shrink-0 rounded-md border">
        <ul className="p-1">
          {filteredTables.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => {
                  setTable(name);
                  setChecked(new Set());
                }}
                className={cn(
                  "w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-xs",
                  table === name ? "bg-accent text-accent-foreground" : "hover:bg-accent",
                )}
              >
                {name}
              </button>
            </li>
          ))}
          {filteredTables.length === 0 && (
            <li className="px-1.5 py-1 text-xs text-muted-foreground">{t("helpers.noTables")}</li>
          )}
        </ul>
      </ScrollArea>

      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        {table === null ? (
          <p className="p-2 text-xs text-muted-foreground">{t("helpers.pickTable")}</p>
        ) : (
          <ul className="p-1">
            {(columns.data ?? []).map((col) => (
              <li key={col.name}>
                <label className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent">
                  <Checkbox
                    checked={checked.has(col.name)}
                    onCheckedChange={(v) => toggleColumn(col.name, v === true)}
                  />
                  <span className="truncate font-mono">{col.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                    {col.dataType}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-t pt-1.5">
        <Button
          variant="outline"
          size="xs"
          disabled={table === null}
          onClick={() => insertText(generateSelect(skeletonInput, dialect))}
        >
          {t("helpers.generateSelect")}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={checked.size === 0}
          onClick={() => insertText(generateInsert(skeletonInput, dialect))}
        >
          {t("helpers.generateInsert")}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={checked.size === 0}
          onClick={() => insertText(generateUpdate(skeletonInput, dialect))}
        >
          {t("helpers.generateUpdate")}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={table === null}
          onClick={() => insertText(generateDelete(skeletonInput, dialect))}
        >
          {t("helpers.generateDelete")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snippets tab
// ---------------------------------------------------------------------------

function SnippetsHelper({
  insertText,
  getSelection,
}: {
  insertText: (text: string) => void;
  getSelection: () => string;
}) {
  const queryClient = useQueryClient();
  const { data: snippets = [], isPending } = useSnippets();
  const [saving, setSaving] = useState<string | null>(null); // selection text
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const save = useMutation({
    mutationFn: async (args: { name: string; sql: string }) =>
      snippetSave(args.name, args.sql),
    onSuccess: async (snippet) => {
      await queryClient.invalidateQueries({ queryKey: ["snippets"] });
      notify.success(`Snippet “${snippet.name}” saved.`);
      setSaving(null);
      setName("");
    },
    onError: (err) => notify.error(err instanceof Error ? err.message : String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => snippetDelete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["snippets"] });
      setDeleting(null);
    },
    onError: (err) => notify.error(err instanceof Error ? err.message : String(err)),
  });

  const startSave = () => {
    const selection = getSelection().trim();
    if (!selection) {
      notify.info("Select SQL in the editor first.");
      return;
    }
    setName("");
    setSaving(selection);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Button variant="outline" size="xs" onClick={startSave} className="self-end">
        <Scissors data-icon="inline-start" />
        {t("helpers.saveSelection")}
      </Button>

      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        {isPending ? null : snippets.length === 0 ? (
          <p className="p-2 text-xs leading-relaxed text-muted-foreground">
            {t("helpers.snippetsEmpty")}
          </p>
        ) : (
          <ul className="p-1">
            {snippets.map((snippet) => (
              <li
                key={snippet.id}
                className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{snippet.name}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground/70">
                    {snippet.sql.split("\n")[0]}
                  </span>
                </span>
                <span className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="size-5"
                        aria-label={t("helpers.insertAtCursor")}
                        onClick={() => insertText(snippet.sql)}
                      >
                        <Plus className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("helpers.insertAtCursor")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="size-5"
                        aria-label={t("helpers.copySnippet")}
                        onClick={() => {
                          void navigator.clipboard.writeText(snippet.sql);
                          notify.success(t("toast.copied", { name: snippet.name }));
                        }}
                      >
                        <Copy className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("helpers.copySnippet")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="size-5 text-destructive hover:text-destructive"
                        aria-label={t("helpers.deleteSnippet", { name: snippet.name })}
                        onClick={() => setDeleting({ id: snippet.id, name: snippet.name })}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("dialog.close")}</TooltipContent>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>

      {/* Name prompt for saving the current selection */}
      <Dialog open={saving !== null} onOpenChange={(open) => !open && setSaving(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("helpers.saveSelection")}</DialogTitle>
            <DialogDescription className="line-clamp-3 font-mono text-xs">
              {saving}
            </DialogDescription>
          </DialogHeader>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="snippet-name" className="text-xs text-muted-foreground">
              {t("helpers.snippetName")}
            </FieldLabel>
            <Input
              id="snippet-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && saving) {
                  save.mutate({ name: name.trim(), sql: saving });
                }
              }}
              placeholder={t("helpers.snippetNamePlaceholder")}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSaving(null)}>
              {t("dialog.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!name.trim() || !saving || save.isPending}
              onClick={() => saving && save.mutate({ name: name.trim(), sql: saving })}
            >
              {t("helpers.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("helpers.deleteSnippet", { name: deleting?.name ?? "" })}
        description={t("helpers.deleteSnippetBody", { name: deleting?.name ?? "" })}
        destructive
        busy={remove.isPending}
        confirmLabel="Delete"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference tab
// ---------------------------------------------------------------------------

function ReferenceHelper({ insertText }: { insertText: (text: string) => void }) {
  return (
    <ScrollArea className="h-full min-h-0">
      <div className="flex flex-col gap-3 p-2" title={t("helpers.keywordsTitle")}>
        {REFERENCE_GROUPS.map((group) => (
          <section key={group.label}>
            <h4 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <Type className="size-3" />
              {group.label}
            </h4>
            <ul className="flex flex-col">
              {group.functions.map((fn) => (
                <li key={fn.name}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => insertText(`${fn.name}(`)}
                        className="w-full truncate rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-accent"
                      >
                        {fn.signature}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-64">
                      {fn.description}
                    </TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Keywords
          </h4>
          <div className="flex flex-wrap gap-1">
            {REFERENCE_KEYWORDS.map((kw) => (
              <button
                key={kw}
                type="button"
                onClick={() => insertText(kw)}
                className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent"
              >
                {kw}
              </button>
            ))}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
