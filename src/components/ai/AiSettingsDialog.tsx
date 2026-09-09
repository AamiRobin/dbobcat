import { useEffect, useState } from "react";

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
import { Switch } from "@/components/ui/switch";
import { t, type TKey } from "@/lib/i18n";
import { useMcpPolicy } from "@/lib/mcp-policy";
import {
  deleteAiKey,
  fetchAiKeyStatus,
  saveAiKey,
  testAiProvider,
} from "@/lib/ai-queries";
import { refreshKeyHint, useAiStore } from "@/stores/ai";
import { notify } from "@/lib/toast";
import { log } from "@/stores/log";

/**
 * AI assistant settings (Phase 12): BYOK configuration. Non-secret config
 * lives in the frontend store; the API key goes straight to the encrypted
 * credential store and is only ever echoed back as a masked hint.
 */

/** Endpoint presets. Local ones keep every byte on the machine. */
const PRESETS: { id: TKey; baseUrl: string }[] = [
  { id: "ai.settings.preset.openai", baseUrl: "https://api.openai.com/v1" },
  { id: "ai.settings.preset.openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ai.settings.preset.ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "ai.settings.preset.lmstudio", baseUrl: "http://localhost:1234/v1" },
];

export function AiSettingsDialog() {
  const open = useAiStore((s) => s.dialogOpen);
  const enabled = useAiStore((s) => s.enabled);
  const baseUrl = useAiStore((s) => s.baseUrl);
  const model = useAiStore((s) => s.model);
  const keyHint = useAiStore((s) => s.keyHint);
  const setEnabled = useAiStore((s) => s.setEnabled);
  const patch = useAiStore((s) => s.patch);
  const setDialogOpen = useAiStore((s) => s.setDialogOpen);

  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testReply, setTestReply] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // Sync the masked hint with the encrypted store each time the dialog
  // opens (the key may have been added/removed since), and never let a
  // half-typed key linger in React state after the dialog closes.
  useEffect(() => {
    if (open) {
      void refreshKeyHint();
    } else {
      setKeyDraft("");
    }
  }, [open]);

  const handleSaveKey = async () => {
    if (!keyDraft.trim()) return;
    setSavingKey(true);
    try {
      await saveAiKey(keyDraft.trim());
      const status = await fetchAiKeyStatus();
      useAiStore.getState().setKeyHint(status.hasKey ? (status.hint ?? "•••") : null);
      setKeyDraft("");
      notify.success("AI key saved");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveKey = async () => {
    try {
      await deleteAiKey();
      useAiStore.getState().setKeyHint(null);
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTest = async () => {
    if (!baseUrl.trim() || !model.trim()) return;
    setTesting(true);
    setTestReply(null);
    setTestError(null);
    try {
      const reply = await testAiProvider({ baseUrl: baseUrl.trim(), model: model.trim() });
      setTestReply(reply.trim() || "OK");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestError(message);
      log("error", `AI test failed: ${message}`);
    } finally {
      setTesting(false);
    }
  };

  // -- agent access (MCP) ---------------------------------------------------
  const { policy: mcp, sessions: mcpSessions, loaded: mcpLoaded, update: updateMcp } = useMcpPolicy(open);

  const toggleSessionAllowed = (id: string, allowed: boolean) => {
    const next = allowed
      ? [...mcp.allowed.filter((x) => x !== id), id]
      : mcp.allowed.filter((x) => x !== id);
    updateMcp({ ...mcp, allowed: next });
  };

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ai.settings.title")}</DialogTitle>
          <DialogDescription>{t("ai.settings.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            {t("ai.settings.enable")}
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label={t("ai.settings.enable")}
            />
          </label>

          <Field>
            <FieldLabel>{t("ai.settings.presets")}</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  variant={baseUrl === preset.baseUrl ? "secondary" : "outline"}
                  size="xs"
                  onClick={() => patch({ baseUrl: preset.baseUrl })}
                >
                  {t(preset.id)}
                </Button>
              ))}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="ai-base-url">{t("ai.settings.baseUrl")}</FieldLabel>
            <Input
              id="ai-base-url"
              value={baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="ai-model">{t("ai.settings.model")}</FieldLabel>
            <Input
              id="ai-model"
              value={model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder={t("ai.settings.modelPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="ai-key">{t("ai.settings.apiKey")}</FieldLabel>
            <div className="flex items-center gap-1.5">
              <Input
                id="ai-key"
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveKey();
                }}
                placeholder={keyHint ? t("ai.settings.keyStored", { hint: keyHint }) : t("ai.settings.apiKeyPlaceholder")}
                autoComplete="off"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!keyDraft.trim() || savingKey}
                onClick={() => void handleSaveKey()}
              >
                {t("ai.settings.saveKey")}
              </Button>
              {keyHint && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void handleRemoveKey()}>
                  {t("ai.settings.removeKey")}
                </Button>
              )}
            </div>
          </Field>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!baseUrl.trim() || !model.trim() || keyHint === null || testing}
              onClick={() => void handleTest()}
            >
              {testing ? t("ai.settings.testing") : t("ai.settings.test")}
            </Button>
            {keyHint === null && (
              <span className="text-xs text-muted-foreground">{t("ai.settings.saveFirst")}</span>
            )}
            {testReply && (
              <span className="truncate text-xs text-emerald-600 dark:text-emerald-400">
                {t("ai.settings.testOk", { reply: testReply })}
              </span>
            )}
            {testError && (
              <span className="truncate text-xs text-destructive">{testError}</span>
            )}
          </div>

          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("ai.settings.privacyNote")}
          </p>

          <div className="border-t pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">{t("ai.mcp.title")}</span>
              <Switch
                checked={mcp.enabled}
                onCheckedChange={(enabled) => updateMcp({ ...mcp, enabled })}
                aria-label={t("ai.mcp.enable")}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("ai.mcp.description")}</p>

            {mcp.enabled && (
              <div className="mt-2">
                {!mcpLoaded ? (
                  <p className="text-xs text-muted-foreground">{t("ai.mcp.loading")}</p>
                ) : mcpSessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("ai.mcp.empty")}</p>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
                    {mcpSessions.map((session) => (
                      <label key={session.id} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="accent-[var(--primary)]"
                          checked={mcp.allowed.includes(session.id)}
                          onChange={(e) => toggleSessionAllowed(session.id, e.target.checked)}
                        />
                        <span className="truncate">{session.name}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground">{session.dbType}</span>
                      </label>
                    ))}
                  </div>
                )}
                {mcp.enabled && mcp.allowed.length === 0 && mcpLoaded && (
                  <p className="mt-1 text-xs text-muted-foreground">{t("ai.mcp.noSelection")}</p>
                )}
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">{t("ai.mcp.cliHint")}</p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            {t("dialog.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
