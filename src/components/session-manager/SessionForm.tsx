import {
  Database,
  DatabaseZap,
  File,
  FolderOpen,
  PlugZap,
  Upload,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { pickOpenPath } from "@/lib/export-queries";
import { SESSION_COLORS } from "@/lib/session-groups";
import type { IsolationLevel, DbType, TestResult } from "@/types/ipc";

import {
  draftWithEngine,
  isServerEngine,
  type SessionDraft,
} from "./session-draft";

interface SessionFormProps {
  draft: SessionDraft;
  secrets: { password: string; sshPassword: string };
  onChange: (draft: SessionDraft) => void;
  onSecretsChange: (secrets: { password: string; sshPassword: string }) => void;
  testResult: TestResult | null;
  testPending: boolean;
  /** Known folder paths for the group input's datalist. */
  existingGroups?: string[];
}

const ENGINE_CARDS: Array<{
  value: DbType;
  label: string;
  hintKey: "session.form.engine.server" | "session.form.engine.file";
  icon: typeof Database;
}> = [
  { value: "mysql", label: "MySQL / MariaDB", hintKey: "session.form.engine.server", icon: Database },
  { value: "postgres", label: "PostgreSQL", hintKey: "session.form.engine.server", icon: DatabaseZap },
  { value: "sqlite", label: "SQLite", hintKey: "session.form.engine.file", icon: File },
];

const SQLITE_FILE_FILTERS = [
  { name: "SQLite database (*.sqlite;*.db;*.sqlite3)", extensions: ["sqlite", "db", "sqlite3"] },
];

/** Isolation-level display labels for the session form Select. */
const isolationLabels: Record<IsolationLevel, string> = {
  "read_uncommitted": t("tx.isolation.readUncommitted"),
  "read_committed": t("tx.isolation.readCommitted"),
  "repeatable_read": t("tx.isolation.repeatableRead"),
  serializable: t("tx.isolation.serializable"),
};

export function SessionForm({
  draft,
  secrets,
  onChange,
  onSecretsChange,
  testResult,
  testPending,
  existingGroups = [],
}: SessionFormProps) {
  const patch = (partial: Partial<SessionDraft>) => onChange({ ...draft, ...partial });
  const [browsing, setBrowsing] = useState(false);
  const server = isServerEngine(draft.engine);

  const browseSqliteFile = async () => {
    setBrowsing(true);
    try {
      const path = await ipc<string | null>("pick_open_path", {
        filters: SQLITE_FILE_FILTERS,
      });
      if (path) {
        patch({ host: path });
        if (draft.name.trim() === "") {
          const stem = path.split(/[\\/]/).pop()?.replace(/\.(sqlite3?|db)$/i, "");
          if (stem) onChange({ ...draft, host: path, name: stem });
        }
      }
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FieldGroup className="min-h-0 flex-1 gap-4 overflow-y-auto px-4 py-3">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="session-name" className="text-xs text-muted-foreground">
            {t("session.form.name")}
          </FieldLabel>
          <Input
            id="session-name"
            value={draft.name}
            placeholder="My local server"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>

        {/* Engine selector */}
        <div className="grid grid-cols-3 gap-2">
          {ENGINE_CARDS.map(({ value, label, hintKey, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange(draftWithEngine(draft, value))}
              aria-pressed={draft.engine === value}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-[11px] transition-colors",
                draft.engine === value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent/60",
              )}
            >
              <Icon className="size-4" />
              <span className="font-medium leading-tight">{label}</span>
              <span className="text-[10px] opacity-70">{t(hintKey)}</span>
            </button>
          ))}
        </div>

        {draft.engine === "sqlite" ? (
          <Field className="gap-1.5">
            <FieldLabel htmlFor="session-file" className="text-xs text-muted-foreground">
              {t("session.form.file")}
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                id="session-file"
                value={draft.host}
                placeholder="/path/to/database.sqlite"
                className="font-mono text-xs"
                onChange={(e) => patch({ host: e.target.value })}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={browsing}
                onClick={() => void browseSqliteFile()}
              >
                <Upload data-icon="inline-start" />
                {t("session.form.browse")}
              </Button>
            </div>
            <FieldDescription className="text-[11px]">
              {t("session.form.sqliteHint")}
            </FieldDescription>
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_100px] gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-host" className="text-xs text-muted-foreground">
                  {t("session.form.host")}
                </FieldLabel>
                <Input
                  id="session-host"
                  value={draft.host}
                  placeholder="127.0.0.1"
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-port" className="text-xs text-muted-foreground">
                  {t("session.form.port")}
                </FieldLabel>
                <Input
                  id="session-port"
                  type="number"
                  value={Number.isNaN(draft.port) ? "" : draft.port}
                  min={1}
                  max={65535}
                  onChange={(e) =>
                    patch({ port: e.target.value === "" ? Number.NaN : Number(e.target.value) })
                  }
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-user" className="text-xs text-muted-foreground">
                  {t("session.form.user")}
                </FieldLabel>
                <Input
                  id="session-user"
                  value={draft.user}
                  autoComplete="off"
                  onChange={(e) => patch({ user: e.target.value })}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-password" className="text-xs text-muted-foreground">
                  {t("session.form.password")}
                </FieldLabel>
                <Input
                  id="session-password"
                  type="password"
                  value={secrets.password}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  onChange={(e) => onSecretsChange({ ...secrets, password: e.target.value })}
                />
              </Field>
            </div>
            <p className="-mt-2 text-[11px] text-muted-foreground/70">
              {t("session.form.passwordHint")}
            </p>

            <div className="grid grid-cols-2 items-end gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-database" className="text-xs text-muted-foreground">
                  {t("session.form.database")}
                </FieldLabel>
                <Input
                  id="session-database"
                  value={draft.database}
                  placeholder="optional"
                  onChange={(e) => patch({ database: e.target.value })}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel className="text-xs text-muted-foreground">
                  {t("session.form.sslMode")}
                </FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={draft.sslMode}
                  onValueChange={(v) => v && patch({ sslMode: v as SessionDraft["sslMode"] })}
                  className="w-full grid grid-cols-3"
                >
                  <ToggleGroupItem value="disabled" className="text-xs">
                    {t("session.form.ssl.disabled")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="preferred" className="text-xs">
                    {t("session.form.ssl.preferred")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="required" className="text-xs">
                    {t("session.form.ssl.required")}
                  </ToggleGroupItem>
                </ToggleGroup>
                {draft.sslMode !== "disabled" && (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {(
                      [
                        ["sslCertPath", "Client cert (.pem)"],
                        ["sslKeyPath", "Client key (.pem)"],
                        ["sslCaPath", "CA cert (.pem)"],
                      ] as const
                    ).map(([field, label]) => (
                      <Field key={field} className="gap-1">
                        <FieldLabel className="text-[10px] text-muted-foreground">
                          {label}
                        </FieldLabel>
                        <div className="flex items-center gap-1">
                          <Input
                            value={draft[field]}
                            onChange={(e) => patch({ [field]: e.target.value })}
                            className="h-7 font-mono text-[11px]"
                            aria-label={label}
                          />
                          <Button
                            variant="outline"
                            size="icon-xs"
                            aria-label={`Browse ${label}`}
                            onClick={async () => {
                              const path = await pickOpenPath([
                                { name: "PEM certificates/keys", extensions: ["pem", "crt", "key", "cer"] },
                                { name: "All files", extensions: ["*"] },
                              ]);
                              if (path) patch({ [field]: path });
                            }}
                          >
                            <FolderOpen className="size-3.5" />
                          </Button>
                        </div>
                      </Field>
                    ))}
                  </div>
                )}
              </Field>
            </div>

            <Separator className="my-1" />

            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{t("session.form.sshTunnel")}</span>
                <span className="text-[11px] text-muted-foreground">
                  {t("session.form.sshHint")}
                </span>
              </div>
              <Switch
                checked={draft.useSsh}
                onCheckedChange={(checked) => patch({ useSsh: checked })}
                aria-label={t("session.form.useSshTunnel")}
              />
            </div>
          </>
        )}

        {draft.useSsh && server && (
          <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
            <div className="grid grid-cols-[1fr_90px] gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-ssh-host" className="text-xs text-muted-foreground">
                  {t("session.form.sshHost")}
                </FieldLabel>
                <Input
                  id="session-ssh-host"
                  value={draft.sshHost}
                  placeholder="bastion.example.com"
                  onChange={(e) => patch({ sshHost: e.target.value })}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-ssh-port" className="text-xs text-muted-foreground">
                  {t("session.form.port")}
                </FieldLabel>
                <Input
                  id="session-ssh-port"
                  type="number"
                  value={Number.isNaN(draft.sshPort) ? "" : draft.sshPort}
                  min={1}
                  max={65535}
                  onChange={(e) =>
                    patch({
                      sshPort: e.target.value === "" ? Number.NaN : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>

            <Field className="gap-1.5">
              <FieldLabel htmlFor="session-ssh-user" className="text-xs text-muted-foreground">
                {t("session.form.sshUser")}
              </FieldLabel>
              <Input
                id="session-ssh-user"
                value={draft.sshUser}
                autoComplete="off"
                onChange={(e) => patch({ sshUser: e.target.value })}
              />
            </Field>

            <Field className="gap-1.5">
              <FieldLabel className="text-xs text-muted-foreground">
                {t("session.form.auth")}
              </FieldLabel>
              <Select
                value={draft.authMethod}
                onValueChange={(v) => patch({ authMethod: v as SessionDraft["authMethod"] })}
              >
                <SelectTrigger id="session-auth-method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">Password</SelectItem>
                  <SelectItem value="key">Private key</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {draft.authMethod === "password" ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="session-ssh-password" className="text-xs text-muted-foreground">
                  {t("session.form.sshPassword")}
                </FieldLabel>
                <Input
                  id="session-ssh-password"
                  type="password"
                  value={secrets.sshPassword}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  onChange={(e) => onSecretsChange({ ...secrets, sshPassword: e.target.value })}
                />
              </Field>
            ) : (
              <>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="session-key-path" className="text-xs text-muted-foreground">
                    {t("session.form.keyPath")}
                  </FieldLabel>
                  <Input
                    id="session-key-path"
                    value={draft.keyPath}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(e) => patch({ keyPath: e.target.value })}
                  />
                </Field>
                <Field className="gap-1.5">
                  <FieldLabel htmlFor="session-passphrase" className="text-xs text-muted-foreground">
                    {t("session.form.passphrase")}
                  </FieldLabel>
                  <Input
                    id="session-passphrase"
                    type="password"
                    value={draft.passphrase}
                    autoComplete="new-password"
                    onChange={(e) => patch({ passphrase: e.target.value })}
                  />
                </Field>
              </>
            )}
          </div>
        )}

        {/* ---- Phase 9-B: organization + keep-alive ---- */}
        <Separator className="my-1" />

        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="session-group" className="text-xs text-muted-foreground">
              {t("session.form.group")}
            </FieldLabel>
            <Input
              id="session-group"
              value={draft.group}
              placeholder={t("session.form.groupPlaceholder")}
              list="session-group-options"
              onChange={(e) => patch({ group: e.target.value })}
            />
            <datalist id="session-group-options">
              {existingGroups.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          </Field>

          <Field className="gap-1.5">
            <FieldLabel className="text-xs text-muted-foreground">
              {t("session.form.color")}
            </FieldLabel>
            <div className="grid grid-cols-8 gap-1 pt-0.5">
              {SESSION_COLORS.map((hex) => {
                const selected = (draft.color ?? "").toLowerCase() === hex;
                return (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`${t("session.form.color")} ${hex}`}
                    title={hex}
                    onClick={() => patch({ color: selected ? null : hex })}
                    className={cn(
                      "size-4 rounded-full border border-black/10 transition-transform",
                      selected ? "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background" : "hover:scale-110",
                    )}
                    style={{ backgroundColor: hex }}
                  />
                );
              })}
            </div>
          </Field>
        </div>

        <Field className="gap-1.5">
          <FieldLabel htmlFor="session-comment" className="text-xs text-muted-foreground">
            {t("session.form.comment")}
          </FieldLabel>
          <Input
            id="session-comment"
            value={draft.comment}
            placeholder={t("session.form.commentPlaceholder")}
            onChange={(e) => patch({ comment: e.target.value })}
          />
        </Field>

        {server ? (
          <>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="session-keepalive" className="text-xs text-muted-foreground">
                {t("session.form.keepAlive")}
              </FieldLabel>
              <Input
                id="session-keepalive"
                type="number"
                className="w-32 font-mono"
                value={draft.keepAliveSec === "" ? "" : draft.keepAliveSec}
                min={0}
                max={86400}
                placeholder="20"
                onChange={(e) =>
                  patch({
                    keepAliveSec: e.target.value === "" ? "" : Number(e.target.value),
                  })
                }
              />
              <FieldDescription className="text-[11px]">
                {t("session.form.keepAliveHint")}
              </FieldDescription>
            </Field>

            {/* Transactions Phase 1: per-connection tx defaults */}
            <div className="grid grid-cols-[140px_1fr] items-end gap-3">
              <Field className="gap-1.5">
                <FieldLabel className="text-xs text-muted-foreground">
                  {t("session.form.txMode")}
                </FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={draft.txMode === "" ? "auto" : draft.txMode}
                  onValueChange={(v) =>
                    v && patch({ txMode: v as SessionDraft["txMode"] })
                  }
                  className="w-full grid grid-cols-2"
                >
                  <ToggleGroupItem value="auto" className="text-xs">
                    {t("session.form.txMode.auto")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="manual" className="text-xs">
                    {t("session.form.txMode.manual")}
                  </ToggleGroupItem>
                </ToggleGroup>
                <FieldDescription className="text-[11px]">
                  {t("session.form.txModeHint")}
                </FieldDescription>
              </Field>

              <Field className="gap-1.5">
                <FieldLabel className="text-xs text-muted-foreground">
                  {t("session.form.isolation")}
                </FieldLabel>
                <Select
                  value={draft.isolationDefault}
                  onValueChange={(v) => patch({ isolationDefault: v as SessionDraft["isolationDefault"] })}
                >
                  <SelectTrigger id="session-isolation" className="w-full text-xs">
                    {draft.isolationDefault === "" ? (
                      t("session.form.isolation.default")
                    ) : (
                      isolationLabels[draft.isolationDefault]
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" className="text-xs">
                      {t("session.form.isolation.default")}
                    </SelectItem>
                    {(Object.keys(isolationLabels) as Array<keyof typeof isolationLabels>).map(
                      (level) => (
                        <SelectItem key={level} value={level} className="text-xs">
                          {isolationLabels[level]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <FieldDescription className="text-[11px]">
                  {t("session.form.isolationHint")}
                </FieldDescription>
              </Field>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground/70">{t("session.form.keepAliveSqliteHint")}</p>
        )}
      </FieldGroup>

      {/* Test status strip: rendered only while a test runs or a result is
          showing, so no blank bordered bar sits above the action footer. */}
      {(testPending || testResult !== null) && (
        <div className="min-h-9 shrink-0 border-t px-4 py-2">
          {testPending ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("session.testing")}
            </p>
          ) : testResult ? (
            testResult.ok ? (
              <p className="flex items-center gap-2 text-xs text-success">
                <PlugZap className="size-3.5 shrink-0" />
                {t("session.test.connected", {
                  version: testResult.serverVersion ?? t("session.test.unknownVersion"),
                  ms: testResult.elapsedMs,
                })}
              </p>
            ) : (
              <p className="text-xs leading-snug text-destructive">
                {testResult.error || t("session.test.failed")}
              </p>
            )
          ) : null}
        </div>
      )}
    </div>
  );
}
