import type { RoutineKind } from "@/types/ipc";

/**
 * Template SQL pre-filled when the user creates a new view/routine/trigger/
 * event from a tree group context menu. Mirrors Heidi's "create new" flows.
 */

export interface TemplateArgs {
  db: string;
  kind: "view" | "routine" | "trigger" | "event";
  routineKind?: RoutineKind;
}

export function templateFor({ db, kind, routineKind }: TemplateArgs): string {
  const name = `new_${kind}`;
  switch (kind) {
    case "view":
      return `CREATE OR REPLACE VIEW \`${db}\`.\`${name}\` AS
SELECT 1 AS dummy;
`;
    case "routine":
      if (routineKind === "function") {
        return `CREATE FUNCTION \`${db}\`.\`${name}\`(p INT)
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN p * 2;
END;
`;
      }
      return `CREATE PROCEDURE \`${db}\`.\`${name}\`()
BEGIN
  SELECT 1 AS dummy;
END;
`;
    case "trigger":
      return `CREATE TRIGGER \`${db}\`.\`${name}\`
BEFORE INSERT ON \`table_name\`
FOR EACH ROW
BEGIN
  SET NEW.id = NEW.id;
END;
`;
    case "event":
      return `CREATE EVENT \`${db}\`.\`${name}\`
ON SCHEDULE EVERY 1 DAY
DO
BEGIN
  CALL cleanup();
END;
`;
  }
}
