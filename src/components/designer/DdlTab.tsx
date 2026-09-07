import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { notify } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Read-only SHOW CREATE TABLE view with a copy button. */
export function DdlTab({
  createSql,
  theme,
}: {
  createSql: string;
  theme: "dark" | "light";
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(createSql);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    notify.success("toast.copied", { name: "CREATE TABLE" });
  };

  if (!createSql) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-muted-foreground">
          DDL appears here after the table is created.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end border-b bg-muted/30 px-1">
        <Button variant="ghost" size="xs" onClick={() => void copy()}>
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        className={cn(
          "min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed",
          theme === "dark" ? "text-foreground/90" : "text-foreground",
        )}
      >
        {createSql}
      </pre>
    </div>
  );
}
