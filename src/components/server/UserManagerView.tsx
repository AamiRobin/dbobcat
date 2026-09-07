import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Search, ShieldOff } from "lucide-react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyPlaceholder } from "@/components/layout/EmptyPlaceholder";
import { Badge } from "@/components/ui/badge";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dbKeys, fetchDatabases, fetchTables, TREE_STALE_TIME } from "@/lib/db-queries";
import {
  alterUser,
  commonPrivileges,
  createUser,
  dropUser,
  fetchUserGrants,
  fetchUsers,
  grantRevoke,
  serverKeys,
  userLabel,
} from "@/lib/server-queries";
import { cn } from "@/lib/utils";
import { log } from "@/stores/log";
import { notify } from "@/lib/toast";
import type { Tab } from "@/stores/tabs";
import type { GrantScope, UserMeta } from "@/types/ipc";

/**
 * User manager (Phase 7). Left: account list; right: privileges / settings
 * / danger-zone detail. Server tools are gated to MySQL/PostgreSQL — the
 * toolbar never opens this tab on SQLite.
 */
export function UserManagerView({ tab }: { tab: Tab }) {
  const connId = tab.meta.connId;
  if (typeof connId !== "number") {
    return (
      <EmptyPlaceholder icon={KeyRound} title="No connection" hint="Connect to a server first." />
    );
  }
  return <UserManagerInner key={tab.id} connId={connId} />;
}

function UserManagerInner({ connId }: { connId: number }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<UserMeta | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const users = useQuery({
    queryKey: serverKeys.users(connId),
    queryFn: () => fetchUsers(connId),
    refetchOnWindowFocus: false,
  });

  const visible = useMemo(() => {
    const all = users.data ?? [];
    const f = filter.trim().toLowerCase();
    if (!f) return all;
    return all.filter((u) => userLabel(u).toLowerCase().includes(f));
  }, [users.data, filter]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: serverKeys.users(connId) });
    if (selected) {
      void queryClient.invalidateQueries({
        queryKey: serverKeys.grants(connId, selected.user, selected.host ?? null),
      });
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ---- left: account list ---- */}
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center gap-1.5 p-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter users…"
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button variant="outline" size="icon-xs" aria-label="Refresh users" onClick={refresh}>
            {users.isFetching ? <Spinner /> : <RefreshCw />}
          </Button>
        </div>
        <div className="px-2 pb-1.5">
          <Button variant="outline" size="xs" className="w-full" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            Add user
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {visible.map((u) => (
            <button
              key={userLabel(u)}
              type="button"
              onClick={() => setSelected(u)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs",
                selected && userLabel(selected) === userLabel(u)
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent",
              )}
            >
              <span className="truncate font-mono">{userLabel(u)}</span>
              {u.locked && (
                <Badge variant="secondary" className="ml-1 shrink-0 gap-0.5 px-1 py-0">
                  <ShieldOff className="size-2.5" />
                  locked
                </Badge>
              )}
            </button>
          ))}
          {!users.isLoading && visible.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">No accounts match.</p>
          )}
          {users.isError && (
            <p className="p-3 text-xs text-destructive">{(users.error as Error).message}</p>
          )}
        </div>
      </div>

      {/* ---- right: detail ---- */}
      {selected ? (
        <UserDetail connId={connId} user={selected} onChanged={refresh} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xs text-muted-foreground">Select an account to manage it.</p>
        </div>
      )}

      <CreateUserDialog
        connId={connId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(u) => {
          refresh();
          setSelected(u);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function UserDetail({
  connId,
  user,
  onChanged,
}: {
  connId: number;
  user: UserMeta;
  onChanged: () => void;
}) {
  const grants = useQuery({
    queryKey: serverKeys.grants(connId, user.user, user.host ?? null),
    queryFn: () => fetchUserGrants(connId, user.user, user.host ?? null),
    staleTime: TREE_STALE_TIME,
  });

  return (
    <Tabs defaultValue="privileges" className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-3 pt-1.5">
        <span className="font-mono text-xs font-semibold">{userLabel(user)}</span>
        <TabsList className="h-7">
          <TabsTrigger value="privileges" className="text-xs">
            Privileges
          </TabsTrigger>
          <TabsTrigger value="settings" className="text-xs">
            Settings
          </TabsTrigger>
          <TabsTrigger value="danger" className="text-xs">
            Danger zone
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="privileges" className="min-h-0 flex-1 overflow-auto">
        <PrivilegesTab
          connId={connId}
          user={user}
          scopes={grants.data?.scopes ?? []}
          rawStatements={grants.data?.rawStatements ?? []}
          isLoading={grants.isLoading}
          onChanged={onChanged}
        />
      </TabsContent>
      <TabsContent value="settings" className="min-h-0 flex-1 overflow-auto">
        <SettingsTab connId={connId} user={user} onChanged={onChanged} />
      </TabsContent>
      <TabsContent value="danger" className="min-h-0 flex-1 overflow-auto">
        <DangerTab connId={connId} user={user} onChanged={onChanged} />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Privileges tab
// ---------------------------------------------------------------------------

function PrivilegesTab({
  connId,
  user,
  scopes,
  rawStatements,
  isLoading,
  onChanged,
}: {
  connId: number;
  user: UserMeta;
  scopes: GrantScope[];
  rawStatements: string[];
  isLoading: boolean;
  onChanged: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const revokeOne = useMutation({
    mutationFn: (scope: GrantScope) =>
      grantRevoke(connId, {
        user: user.user,
        host: user.host ?? null,
        privileges: scope.privilege === "ALL PRIVILEGES" ? ["ALL PRIVILEGES"] : [scope.privilege],
        db: scope.db ?? null,
        table: scope.table ?? null,
        grantOption: false,
        revoke: true,
      }),
    onSuccess: (_d, scope) => {
      notify.success(`Revoked ${scope.privilege} from ${userLabel(user)}.`);
      onChanged();
    },
    onError: (err) => notify.error(`Revoke failed: ${err.message}`),
  });

  return (
    <div className="grid h-full grid-cols-[1fr_320px] divide-x">
      <div className="min-h-0 overflow-auto p-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold">Parsed privilege scopes</h4>
          <Button variant="outline" size="xs" onClick={() => setDialogOpen(true)}>
            <Plus data-icon="inline-start" />
            Add privilege
          </Button>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              <th className="py-1 pr-2 font-medium">Privilege</th>
              <th className="py-1 pr-2 font-medium">Database</th>
              <th className="py-1 pr-2 font-medium">Table</th>
              <th className="py-1 pr-2 font-medium">Grant option</th>
              <th className="w-16 py-1 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {scopes.map((s, i) => (
              <tr key={`${s.privilege}-${s.db}-${s.table}-${i}`} className="border-b last:border-0">
                <td className="py-1 pr-2 font-mono">{s.privilege}</td>
                <td className="py-1 pr-2 font-mono">{s.db ?? "—"}</td>
                <td className="py-1 pr-2 font-mono">{s.table ?? "—"}</td>
                <td className="py-1 pr-2">{s.grantOption ? "yes" : "no"}</td>
                <td className="py-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={revokeOne.isPending}
                    onClick={() => revokeOne.mutate(s)}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {!isLoading && scopes.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-center text-muted-foreground">
                  No parsed scopes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="min-h-0 overflow-auto bg-muted/30 p-3">
        <h4 className="mb-2 text-xs font-semibold">Raw statements</h4>
        {isLoading ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : (
          <ul className="flex flex-col gap-1.5 ">
            {rawStatements.map((stmt, i) => (
              <li
                key={i}
                className="rounded-md border bg-background p-1.5 font-mono text-xs leading-snug break-all whitespace-pre-wrap"
              >
                {stmt}
              </li>
            ))}
            {rawStatements.length === 0 && (
              <li className="text-muted-foreground">None reported.</li>
            )}
          </ul>
        )}
      </div>

      <AddPrivilegeDialog
        connId={connId}
        user={user}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onDone={onChanged}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-privilege dialog (Grant / Revoke)
// ---------------------------------------------------------------------------

function AddPrivilegeDialog({
  connId,
  user,
  open,
  onOpenChange,
  onDone,
}: {
  connId: number;
  user: UserMeta;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const dialect = user.host ? "mysql" : "postgres";
  const available = commonPrivileges(dialect);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [db, setDb] = useState<string>("__global__");
  const [table, setTable] = useState<string>("__none__");
  const [grantOption, setGrantOption] = useState(false);

  const databases = useQuery({
    queryKey: dbKeys.databases(connId),
    queryFn: () => fetchDatabases(connId),
    enabled: open,
    staleTime: TREE_STALE_TIME,
  });
  const tables = useQuery({
    queryKey: dbKeys.tables(connId, db),
    queryFn: () => fetchTables(connId, db),
    enabled: open && db !== "__global__",
    staleTime: TREE_STALE_TIME,
  });

  const run = useMutation({
    mutationFn: (revoke: boolean) =>
      grantRevoke(connId, {
        user: user.user,
        host: user.host ?? null,
        privileges: [...chosen],
        db: db === "__global__" ? null : db,
        table: db === "__global__" || table === "__none__" ? null : table,
        grantOption,
        revoke,
      }),
    onSuccess: (_d, revoke) => {
      log(
        revoke ? "warn" : "success",
        `${revoke ? "Revoked" : "Granted"} ${[...chosen].join(", ")} ${revoke ? "from" : "to"} ${userLabel(user)}.`,
      );
      setChosen(new Set());
      onOpenChange(false);
      onDone();
    },
    onError: (err) => notify.error(err.message),
  });

  const toggle = (priv: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(priv)) next.delete(priv);
      else next.add(priv);
      return next;
    });

  const canRun = chosen.size > 0 && !run.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Privileges for {userLabel(user)}</DialogTitle>
          <DialogDescription>
            Pick privileges and a scope, then Grant or Revoke.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 ">
          <fieldset className="flex flex-col gap-1.5 max-h-44 overflow-y-auto rounded-md border p-2">
            <legend className="px-1 text-xs text-muted-foreground">Privileges</legend>
            {available.map((priv) => (
              <label key={priv} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={chosen.has(priv)}
                  onCheckedChange={() => toggle(priv)}
                  aria-label={priv}
                />
                <span className="font-mono">{priv}</span>
              </label>
            ))}
          </fieldset>

          <div className="grid grid-cols-2 gap-2">
            <Field className="gap-1">
              <FieldLabel className="text-xs">Database scope</FieldLabel>
              <Select
                value={db}
                onValueChange={(v) => {
                  setDb(v);
                  setTable("__none__");
                }}
              >
                <SelectTrigger size="sm" className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__global__">
                      {dialect === "mysql" ? "Global (*.* )" : "No database"}
                    </SelectItem>
                    {(databases.data ?? []).map((d) => (
                      <SelectItem key={d.name} value={d.name}>
                        {d.name}
                      </SelectItem>
                    ))}

                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="gap-1">
              <FieldLabel className="text-xs">Table (optional)</FieldLabel>
              <Select value={table} onValueChange={setTable}>
                <SelectTrigger size="sm" className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__none__">Whole database</SelectItem>
                    {(tables.data ?? [])
                      .filter((t) => t.kind === "table")
                      .map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name}
                        </SelectItem>
                      ))}

                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="grant-option" className="text-xs">
              WITH GRANT OPTION
            </Label>
            <Switch id="grant-option" checked={grantOption} onCheckedChange={setGrantOption} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="destructive"
            size="sm"
            disabled={!canRun}
            onClick={() => run.mutate(true)}
          >
            Revoke
          </Button>
          <Button size="sm" disabled={!canRun} onClick={() => run.mutate(false)}>
            Grant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

const AUTH_PLUGINS_MYSQL = [
  "caching_sha2_password",
  "mysql_native_password",
  "sha256_password",
] as const;

function SettingsTab({
  connId,
  user,
  onChanged,
}: {
  connId: number;
  user: UserMeta;
  onChanged: () => void;
}) {
  const isMysql = Boolean(user.host);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [newName, setNewName] = useState("");
  const [plugin, setPlugin] = useState<string>(user.authPlugin ?? "caching_sha2_password");
  const [lock, setLock] = useState(user.locked);
  const [limits, setLimits] = useState({
    maxConnections: "",
    maxUserConnections: "",
    maxQueriesPerHour: "",
    maxUpdatesPerHour: "",
  });

  const save = useMutation({
    mutationFn: () =>
      alterUser(connId, user.user, user.host ?? null, {
        newPassword: password === "" ? null : password,
        newName: newName.trim() === "" ? null : newName.trim(),
        authPlugin:
          isMysql && plugin !== "" && plugin !== user.authPlugin ? plugin : null,
        lock,
        limits: {
          maxConnections: numOrNull(limits.maxConnections),
          maxUserConnections: numOrNull(limits.maxUserConnections),
          maxQueriesPerHour: numOrNull(limits.maxQueriesPerHour),
          maxUpdatesPerHour: numOrNull(limits.maxUpdatesPerHour),
        },
      }),
    onSuccess: () => {
      notify.success(`Account ${userLabel(user)} updated.`);
      setPassword("");
      setPassword2("");
      setNewName("");
      onChanged();
    },
    onError: (err) => notify.error(`Alter failed: ${err.message}`),
  });

  const mismatch = password !== "" && password !== password2;

  return (
    <div className="flex flex-col gap-5 mx-auto max-w-md p-4">
      {/* password */}
      <section className="flex flex-col gap-2 ">
        <h4 className="text-xs font-semibold">Password</h4>
        <Input
          type="password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        <Input
          type="password"
          placeholder="Repeat password"
          value={password2}
          onChange={(e) => setPassword2(e.target.value)}
          className={cn(mismatch && "border-destructive")}
          autoComplete="new-password"
        />
        {mismatch && <p className="text-xs text-destructive">Passwords do not match.</p>}
      </section>

      {isMysql && (
        <>
          <section className="flex flex-col gap-2 ">
            <h4 className="text-xs font-semibold">Authentication plugin</h4>
            <Select value={plugin} onValueChange={setPlugin}>
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {AUTH_PLUGINS_MYSQL.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                  {user.authPlugin &&
                    !(AUTH_PLUGINS_MYSQL as readonly string[]).includes(user.authPlugin) && (
                      <SelectItem value={user.authPlugin}>{user.authPlugin}</SelectItem>
                    )}

                </SelectGroup>
              </SelectContent>
            </Select>
          </section>

          <section className="flex flex-col gap-2 ">
            <h4 className="text-xs font-semibold">Rename</h4>
            <Input
              placeholder="Leave empty to keep name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </section>
        </>
      )}

      <section className="flex flex-col gap-2 ">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold">Account</h4>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {lock ? "Locked" : "Unlocked"}
            </span>
            <Switch checked={lock} onCheckedChange={setLock} aria-label="Lock account" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2 ">
        <h4 className="text-xs font-semibold">
          Resource limits{!isMysql && " (connection limit only)"}
        </h4>
        <div className="grid grid-cols-2 gap-2">
          {(isMysql
            ? ([
                ["maxConnections", "MAX_CONNECTIONS"],
                ["maxUserConnections", "MAX_USER_CONNECTIONS"],
                ["maxQueriesPerHour", "MAX_QUERIES_PER_HOUR"],
                ["maxUpdatesPerHour", "MAX_UPDATES_PER_HOUR"],
              ] as const)
            : ([["maxConnections", "CONNECTION LIMIT (-1 unlimited)"]] as const)
          ).map(([key, label]) => (
            <Field key={key} className="gap-1">
              <FieldLabel className="font-mono text-[10px] text-muted-foreground">{label}</FieldLabel>
              <Input
                inputMode="numeric"
                className="h-7 text-xs"
                value={limits[key]}
                onChange={(e) => setLimits((l) => ({ ...l, [key]: e.target.value }))}
                placeholder="—"
              />
            </Field>
          ))}
        </div>
      </section>

      <Button
        size="sm"
        disabled={!canSave(mismatch)}
        onClick={() => save.mutate()}
      >
        {save.isPending && <Spinner data-icon="inline-start" />}
        Save changes
      </Button>
    </div>
  );
}

function numOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Save stays enabled unless the password fields conflict. */
function canSave(mismatch: boolean): boolean {
  return !mismatch;
}

// ---------------------------------------------------------------------------
// Danger zone
// ---------------------------------------------------------------------------

function DangerTab({
  connId,
  user,
  onChanged,
}: {
  connId: number;
  user: UserMeta;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const drop = useMutation({
    mutationFn: () => dropUser(connId, user.user, user.host ?? null),
    onSuccess: () => {
      notify.warning(`Dropped account ${userLabel(user)}.`);
      setConfirmOpen(false);
      onChanged();
    },
    onError: (err) => notify.error(`Drop failed: ${err.message}`),
  });

  return (
    <div className="flex flex-col gap-3 mx-auto max-w-md p-4">
      <Alert variant="destructive" className="border-destructive/50">
        <ShieldOff />
        <AlertTitle className="text-xs">Drop account</AlertTitle>
        <AlertDescription className="text-xs">
          Permanently removes <span className="font-mono">{userLabel(user)}</span> and its
          privileges. This cannot be undone.
        </AlertDescription>
        <Button
          variant="destructive"
          size="sm"
          className="col-start-2 mt-2 w-fit"
          onClick={() => setConfirmOpen(true)}
        >
          Drop user…
        </Button>
      </Alert>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Drop ${userLabel(user)}?`}
        description={
          <>
            The account and its privileges will be removed from the server.
          </>
        }
        confirmLabel="Drop user"
        destructive
        busy={drop.isPending}
        onConfirm={() => drop.mutate()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-user dialog
// ---------------------------------------------------------------------------

function CreateUserDialog({
  connId,
  open,
  onOpenChange,
  onCreated,
}: {
  connId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (user: UserMeta) => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [plugin, setPlugin] = useState<string>("caching_sha2_password");

  const create = useMutation({
    mutationFn: () =>
      createUser(connId, {
        user: name.trim(),
        host: host.trim() === "" ? "%" : host.trim(),
        password: password === "" ? null : password,
        authPlugin: plugin,
      }),
    onSuccess: () => {
      notify.success(`Created user '${name.trim()}'@'${host}'.`);
      const created: UserMeta = {
        user: name.trim(),
        host: host.trim() || "%",
        locked: false,
        authPlugin: plugin,
      };
      setName("");
      setPassword("");
      onOpenChange(false);
      onCreated(created);
    },
    onError: (err) => notify.error(`Create user failed: ${err.message}`),
  });

  // Host field only matters for MySQL; the dialog learns that lazily via the
  // first user row — keep it simple and always show it (PG ignores it).
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>
            PostgreSQL roles ignore the host field.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 ">
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <Field className="gap-1">
              <FieldLabel htmlFor="newuser-name" className="text-xs">User name</FieldLabel>
              <Input id="newuser-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor="newuser-host" className="text-xs">Host (MySQL)</FieldLabel>
              <Input id="newuser-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="%" />
            </Field>
          </div>
          <Field className="gap-1">
            <FieldLabel htmlFor="newuser-password" className="text-xs">Password</FieldLabel>
            <Input
              id="newuser-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel className="text-xs">Auth plugin (MySQL)</FieldLabel>
            <Select value={plugin} onValueChange={setPlugin}>
              <SelectTrigger size="sm" className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {AUTH_PLUGINS_MYSQL.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}

                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <DialogFooter>
          <Button
            size="sm"
            disabled={name.trim() === "" || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending && <Spinner data-icon="inline-start" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
