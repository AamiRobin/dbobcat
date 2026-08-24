import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TableOptions } from "@/types/ipc";

const ENGINES = ["InnoDB", "MyISAM", "Aria", "MEMORY", "CSV"];
const CHARSETS = ["utf8mb4", "utf8mb3", "latin1", "ascii", "binary"];
const ROW_FORMATS = ["Dynamic", "Compact", "Redundant", "Compressed", "Fixed", "Page"];

/** CREATE TABLE tail options editor. */
export function OptionsTab({
  options,
  onChange,
}: {
  options: TableOptions;
  onChange: (options: TableOptions) => void;
}) {
  return (
    <div className="flex flex-col gap-3 max-w-xl p-4">
      <datalist id="designer-engine-options">
        {ENGINES.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
      <datalist id="designer-charset-options">
        {CHARSETS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="designer-rowformat-options">
        {ROW_FORMATS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>

      <FieldGroup className="gap-2">
        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor="opt-engine" className="w-[140px] shrink-0 text-xs text-muted-foreground">
            Engine
          </FieldLabel>
          <Input
            id="opt-engine"
            list="designer-engine-options"
            value={options.engine ?? ""}
            onChange={(e) => onChange({ ...options, engine: e.target.value || null })}
            className="h-7 px-2 font-mono text-xs"
          />
        </Field>

        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor="opt-charset" className="w-[140px] shrink-0 text-xs text-muted-foreground">
            Charset
          </FieldLabel>
          <Input
            id="opt-charset"
            list="designer-charset-options"
            value={options.charset ?? ""}
            onChange={(e) => onChange({ ...options, charset: e.target.value || null })}
            className="h-7 px-2 font-mono text-xs"
          />
        </Field>

        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor="opt-collation" className="w-[140px] shrink-0 text-xs text-muted-foreground">
            Collation
          </FieldLabel>
          <Input
            id="opt-collation"
            value={options.collation ?? ""}
            onChange={(e) => onChange({ ...options, collation: e.target.value || null })}
            className="h-7 font-mono text-xs"
          />
        </Field>

        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor="opt-rowformat" className="w-[140px] shrink-0 text-xs text-muted-foreground">
            Row format
          </FieldLabel>
          <Input
            id="opt-rowformat"
            list="designer-rowformat-options"
            value={options.rowFormat ?? ""}
            onChange={(e) => onChange({ ...options, rowFormat: e.target.value || null })}
            className="h-7 px-2 font-mono text-xs"
          />
        </Field>

        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor="opt-autoinc" className="w-[140px] shrink-0 text-xs text-muted-foreground">
            Auto increment
          </FieldLabel>
          <Input
            id="opt-autoinc"
            type="number"
            min={0}
            value={options.autoIncrement ?? ""}
            onChange={(e) =>
              onChange({
                ...options,
                autoIncrement: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            className="h-7 font-mono text-xs"
          />
        </Field>

        <Field orientation="horizontal" className="items-start gap-2">
          <FieldLabel htmlFor="opt-comment" className="mt-1.5 w-[140px] shrink-0 text-xs text-muted-foreground">
            Comment
          </FieldLabel>
          <Textarea
            id="opt-comment"
            rows={3}
            value={options.comment ?? ""}
            onChange={(e) => onChange({ ...options, comment: e.target.value || null })}
            className="min-h-0 px-2 py-1.5 text-xs"
          />
        </Field>
      </FieldGroup>
    </div>
  );
}
