import { toast } from "sonner";

import { en, t, type TKey } from "@/lib/i18n";

type Vars = Record<string, string | number>;

/**
 * Action-feedback notifications (sonner). SQL/telemetry stays in the
 * message log (`stores/log`); use these for user-facing outcomes of
 * explicit actions (copy, save, export, post changes, …).
 *
 * Messages accept an i18n key (translated through `t()`) or a literal
 * string for one-off dynamic text.
 */
function resolve(text: TKey | string, vars?: Vars): string {
  return text in en ? t(text as TKey, vars) : text;
}

export const notify = {
  success: (text: TKey | string, vars?: Vars) => toast.success(resolve(text, vars)),
  error: (text: TKey | string, vars?: Vars) => toast.error(resolve(text, vars)),
  warning: (text: TKey | string, vars?: Vars) => toast.warning(resolve(text, vars)),
  info: (text: TKey | string, vars?: Vars) => toast.info(resolve(text, vars)),
};
