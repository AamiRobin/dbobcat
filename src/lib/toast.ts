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

/**
 * When the last error toast fired. Lets interruptive UI (star prompt) hold
 * off while the user is dealing with a failure.
 */
let lastErrorToastAt = 0;

export function msSinceLastErrorToast(): number {
  return Date.now() - lastErrorToastAt;
}

export const notify = {
  success: (text: TKey | string, vars?: Vars) => toast.success(resolve(text, vars)),
  error: (text: TKey | string, vars?: Vars) => {
    lastErrorToastAt = Date.now();
    toast.error(resolve(text, vars));
  },
  warning: (text: TKey | string, vars?: Vars) => toast.warning(resolve(text, vars)),
  info: (text: TKey | string, vars?: Vars) => toast.info(resolve(text, vars)),
};
