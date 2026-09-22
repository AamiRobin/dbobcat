import type { DiagramEdge, DiagramNode } from "./diagram-model";

/**
 * Schema copy utilities for the ER view (Supabase's "Copy as SQL" /
 * schema-as-Markdown). Output is dialect-neutral ISO SQL: quoted
 * identifiers, no driver-specific column options — meant for sharing and
 * reading, not for re-executing against a specific engine.
 */

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnLine(node: DiagramNode, index: number, col: (typeof node.columns)[number]): string {
  let line = `  ${q(col.name)} ${col.dataType}`;
  if (!col.nullable) line += " NOT NULL";
  if (col.defaultValue !== null && col.defaultValue !== undefined && col.defaultValue !== "") {
    line += ` DEFAULT ${col.defaultValue}`;
  }
  if (index < node.columns.length - 1 || node.pkNames.length > 0) line += ",";
  return line;
}

/** CREATE TABLE statements + FK ALTERs for the given nodes/edges. */
export function tablesToSql(nodes: DiagramNode[], edges: DiagramEdge[]): string {
  const chunks: string[] = [];

  for (const node of nodes) {
    if (node.columns.length === 0) continue;
    const lines: string[] = [];
    for (let i = 0; i < node.columns.length; i++) {
      lines.push(columnLine(node, i, node.columns[i]));
    }
    if (node.pkNames.length > 0) {
      const pk = node.columns
        .filter((c) => node.pkNames.includes(c.name))
        .map((c) => q(c.name))
        .join(", ");
      lines.push(`  PRIMARY KEY (${pk})${edges.some((e) => e.target === node.id) ? "," : ""}`);
    }
    chunks.push(`CREATE TABLE ${q(node.id)} (\n${lines.join("\n")}\n);`);
  }

  for (const edge of edges) {
    const actions = [
      edge.onDelete ? ` ON DELETE ${edge.onDelete}` : "",
      edge.onUpdate ? ` ON UPDATE ${edge.onUpdate}` : "",
    ].join("");
    chunks.push(
      `ALTER TABLE ${q(edge.target)}\n  ADD CONSTRAINT ${q(edge.name)}\n  FOREIGN KEY (${q(edge.targetColumn)}) REFERENCES ${q(edge.source)} (${q(edge.sourceColumn)})${actions};`,
    );
  }

  return chunks.join("\n\n");
}

/** Compact per-table Markdown reference (column / type / nullability / key). */
export function schemaToMarkdown(nodes: DiagramNode[]): string {
  const sections: string[] = [];
  for (const node of nodes) {
    if (node.columns.length === 0) continue;
    const rows = node.columns.map((c) => {
      const key = node.fkColumns.has(c.name)
        ? "FK"
        : c.key === "PRI"
          ? "PK"
          : (c.key === "UNI" ? "UNIQUE" : "");
      return `| ${c.name} | ${c.dataType} | ${c.nullable ? "yes" : "no"} | ${key} |`;
    });
    sections.push(
      `### ${node.id}\n\n| Column | Type | Nullable | Key |\n| --- | --- | --- | --- |\n${rows.join("\n")}`,
    );
  }
  return sections.join("\n\n");
}
