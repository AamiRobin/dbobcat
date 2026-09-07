import { useQuery } from "@tanstack/react-query";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { alterTable } from "@/lib/object-queries";
import { notify } from "@/lib/toast";
import type { TableDdl } from "@/types/ipc";

/**
 * "Preview ALTER" dialog: runs the backend diff in dry-run mode and lists
 * the statements (copyable) plus non-fatal warnings.
 */
export function AlterPreviewDialog({
  open,
  onOpenChange,
  connId,
  db,
  table,
  desired,
  createMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connId: number;
  db: string;
  table?: string;
  desired: TableDdl;
  createMode: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const preview = useQuery({
    queryKey: ["obj-alter-preview", connId, db, table, desired],
    queryFn: () => alterTable(connId, db, table!, structuredClone(desired), true),
    enabled: open && !createMode && table !== undefined,
    staleTime: 0,
    gcTime: 0,
  });

  // Create mode previews the CREATE statement the same way.
  let body: React.ReactNode;
  if (createMode) {
    body = (
      <p className="text-xs text-muted-foreground">
        Creating executes one CREATE TABLE statement built from this draft —
        use <span className="font-medium text-foreground">Create</span> to run it.
      </p>
    );
  } else if (preview.isPending) {
    body = (
      <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        Computing diff…
      </p>
    );
  } else if (preview.isError) {
    body = (
      <p className="py-2 font-mono text-xs text-destructive">
        {(preview.error as Error)?.message}
      </p>
    );
  } else {
    const result = preview.data;
    const statements = result?.statements ?? [];
    body = (
      <div className="flex flex-col gap-3 ">
        {result?.warnings && result.warnings.length > 0 && (
          <Alert className="border-warning/40 bg-warning/10 *:[svg]:text-warning">
            <TriangleAlert className="size-3" />
            <AlertTitle className="sr-only">Warnings</AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-1 text-xs leading-snug">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {statements.length === 0 ? (
          <p className="text-xs text-muted-foreground">No differences detected.</p>
        ) : (
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2.5 font-mono text-xs leading-relaxed">
            {statements.map((s, i) => (
              <div key={i}>
                {s};
                {"\n"}
              </div>
            ))}
          </pre>
        )}
      </div>
    );
  }

  const copyStatements = async () => {
    const stmts = preview.data?.statements ?? [];
    await navigator.clipboard.writeText(stmts.map((s) => `${s};`).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    notify.success("toast.copied", { name: "ALTER statements" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ALTER preview</DialogTitle>
          <DialogDescription>
            Statements the designer will execute against{" "}
            <span className="font-mono">{db}.{table}</span>. Review before applying.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-24">{body}</div>

        <DialogFooter>
          {!createMode &&
            preview.data?.statements &&
            preview.data.statements.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void copyStatements()}>
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {copied ? "Copied" : "Copy SQL"}
              </Button>
            )}
          <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
