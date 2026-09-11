import type { QueryClient } from "@tanstack/react-query";

import { dataKeys } from "@/lib/db-queries";
import { diaKeys } from "@/lib/diagram-queries";
import { objKeys } from "@/lib/object-queries";

/**
 * Drop every cached view of one table after a write changed it on the
 * server (truncate, ALTER, CSV import, rename, …). Covers open data grids
 * (page cache), the designer's DDL snapshot, FK dropdown caches and the
 * whole-schema diagram/AI scans — all lazily refetched, nothing forced.
 */
export function invalidateTableArtifacts(
  client: QueryClient,
  connId: number,
  db: string,
  table: string,
): void {
  void client.invalidateQueries({ queryKey: dataKeys.table(connId, db, table) });
  void client.invalidateQueries({ queryKey: objKeys.ddl(connId, db, table) });
  void client.invalidateQueries({ queryKey: objKeys.foreignKeys(connId, db, table) });
  void client.invalidateQueries({ queryKey: objKeys.referencingFks(connId, db, table) });
  void client.invalidateQueries({ queryKey: diaKeys.all(connId) });
}
