import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Diamond, Hash, KeyRound, Link, Table2, X } from "lucide-react";

import type { ColumnMeta } from "@/types/ipc";
import type { DiagramNode } from "@/lib/diagram-model";
import { cn } from "@/lib/utils";
import { useDiagramUi } from "./diagram-ui-context";

/**
 * Supabase-style table card for the ER canvas: icon header + name + column
 * count, one 22px row per column (name left, mono type right), key glyphs
 * (PRI key, UNI diamond, identity hash, FK link). Every FK/referenced column
 * row carries hidden React Flow handles (id = column name) so relationship
 * edges attach to the exact row — the signature schema-visualizer look.
 */

export const NODE_WIDTH_PX = 240;

export interface TableNodeData extends Record<string, unknown> {
  /** Full model node (columns, pkNames, fkColumns). */
  table: DiagramNode;
  /** Rows actually rendered (keys-only filter + row cap already applied). */
  rows: ColumnMeta[];
  /** Rows hidden behind the "+N more" footer. */
  hiddenCount: number;
}

export type TableFlowNode = Node<TableNodeData, "table">;

/** Handles are tiny invisible divs; this keeps them out of layout/pointer UX. */
const hiddenConnector =
  "!h-px !w-px !min-w-0 !min-h-0 !border-0 !p-0 !opacity-0 !pointer-events-none";

function isIdentity(col: ColumnMeta): boolean {
  const extra = col.extra ?? "";
  return extra.includes("auto_increment") || extra.includes("identity");
}

const ColumnRow = memo(function ColumnRow({
  col,
  isPk,
  isFk,
  isReferenced,
  nullableDim,
}: {
  col: ColumnMeta;
  isPk: boolean;
  isFk: boolean;
  isReferenced: boolean;
  nullableDim: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex h-[22px] items-center gap-1.5 border-t border-border/50 px-2",
        "hover:bg-accent/40",
      )}
    >
      <span className="flex w-3.5 shrink-0 items-center justify-center">
        {isPk && <KeyRound className="size-3 text-amber-500" />}
        {!isPk && isFk && <Link className="size-3 text-sky-500" />}
        {!isPk && !isFk && col.key === "UNI" && <Diamond className="size-3 text-muted-foreground/80" />}
        {!isPk && !isFk && col.key !== "UNI" && isIdentity(col) && (
          <Hash className="size-3 text-muted-foreground/60" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-xs",
          isPk ? "font-medium" : "text-card-foreground/90",
        )}
        title={col.name}
      >
        {col.name}
      </span>
      <span
        className={cn(
          "ml-auto shrink-0 font-mono text-[10px] leading-none",
          nullableDim ? "text-muted-foreground/60" : "text-muted-foreground",
        )}
      >
        {col.dataType}
      </span>
      {/*
        Handle sides follow the reference layout: FK edges LEAVE the child's
        right edge and ENTER the parent's left edge (marker points at the
        referenced column). A column can be both FK and referenced.
      */}
      {isFk && (
        <Handle
          type="source"
          id={col.name}
          position={Position.Right}
          className={hiddenConnector}
          isConnectable={false}
        />
      )}
      {isReferenced && (
        <Handle
          type="target"
          id={col.name}
          position={Position.Left}
          className={hiddenConnector}
          isConnectable={false}
        />
      )}
    </div>
  );
});

function TableNodeImpl({ id, data, selected }: NodeProps<TableFlowNode>) {
  const { relatedIds, matchIds, onHideNode } = useDiagramUi();
  const node = data.table;

  const dimmed =
    (relatedIds !== null && !relatedIds.has(id)) ||
    (matchIds !== null && !matchIds.has(id));

  return (
    <article
      className={cn(
        "group overflow-hidden rounded-md border border-[0.5px] bg-card text-card-foreground shadow-sm transition-opacity",
        selected && "border-primary shadow-md",
        dimmed && "opacity-30",
      )}
      style={{ width: NODE_WIDTH_PX }}
      aria-label={`table ${id}`}
    >
      <header className="flex h-[30px] items-center gap-1.5 border-b bg-muted/70 px-2">
        <Table2 className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-xs font-semibold" title={id}>
          {id}
        </span>
        <span className="ml-auto flex size-4.5 shrink-0 items-center justify-center rounded-full border border-border text-[9px] tabular-nums text-muted-foreground">
          {node.totalColumns}
        </span>
        <button
          type="button"
          aria-label={`hide ${id}`}
          className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onHideNode(id);
          }}
        >
          <X className="size-3" />
        </button>
      </header>

      <div>
        {data.rows.map((col) => (
          <ColumnRow
            key={col.name}
            col={col}
            isPk={node.pkNames.includes(col.name)}
            isFk={node.fkColumns.has(col.name)}
            isReferenced={node.referencedColumns.has(col.name)}
            nullableDim={col.nullable}
          />
        ))}
        {data.hiddenCount > 0 && (
          <footer className="flex h-5 items-center justify-center border-t bg-muted/30 text-[10px] text-muted-foreground">
            +{data.hiddenCount} more
          </footer>
        )}
      </div>
    </article>
  );
}

/**
 * Memo comparator mirroring Supabase's SchemaTableNode: pan/zoom and
 * unrelated state changes must not re-render cards (in v12 the node wrapper
 * applies position transforms itself, so data/selected are the only inputs).
 * `data` identity is kept stable by the view.
 */
export const TableNode = memo(
  TableNodeImpl,
  (a, b) => a.id === b.id && a.data === b.data && a.selected === b.selected,
);
