import type { DbType, IsolationLevel, SavedSession, SslMode, TxMode } from "@/types/ipc";

/** Flat editor state for the session dialog form. */
export interface SessionDraft {
  id: string;
  name: string;
  /** mysql | postgres | sqlite */
  engine: DbType;
  host: string;
  port: number;
  user: string;
  database: string; // "" → null
  sslMode: SslMode;
  useSsh: boolean;
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  authMethod: "password" | "key";
  keyPath: string;
  passphrase: string;
  // Phase 9-B organization + resilience.
  /** Slash-separated folder path; "" → null. */
  group: string;
  /** One of SESSION_COLORS; null = no color dot. */
  color: string | null;
  /** Free-form note; "" → null. */
  comment: string;
  /**
   * Keep-alive ping seconds; "" (unset) follows the backend's 20s default,
   * explicit 0 disables. SQLite ignores it entirely.
   */
  keepAliveSec: number | "";
  // Transactions UI Phase 1 defaults (server engines only; SQLite hides them).
  /** Initial transaction mode; "" = auto-commit (backend default). */
  txMode: TxMode | "";
  /** Isolation level applied at connect; "" = server default. */
  isolationDefault: IsolationLevel | "";
}

/** Secret fields kept out of the draft so they never round-trip the UI. */
export interface DraftSecrets {
  password: string;
  sshPassword: string;
}

/** True when the engine talks to a server (as opposed to a local file). */
export function isServerEngine(engine: DbType): boolean {
  return engine !== "sqlite";
}

/** Default connection parameters per engine. */
export const ENGINE_DEFAULTS: Record<
  DbType,
  { host: string; port: number; user: string }
> = {
  mysql: { host: "127.0.0.1", port: 3306, user: "root" },
  postgres: { host: "127.0.0.1", port: 5432, user: "postgres" },
  // SQLite stores its database file path in `host`.
  sqlite: { host: "", port: 0, user: "" },
};

/**
 * Derive a session name from the connection target: `user@host` for server
 * engines — via the SSH hop when a tunnel is configured, since the database
 * host is usually 127.0.0.1 through it — and the file stem for SQLite paths.
 * Empty parts are dropped, so a missing user yields just the host.
 */
export function deriveSessionName(draft: SessionDraft): string {
  if (draft.engine === "sqlite") {
    const stem = draft.host.split(/[\\/]/).pop()?.replace(/\.(sqlite3?|db)$/i, "");
    return stem?.trim() ?? "";
  }
  const viaSsh = draft.useSsh && draft.sshHost.trim() !== "";
  const user = (viaSsh ? draft.sshUser : draft.user).trim();
  const host = (viaSsh ? draft.sshHost : draft.host).trim();
  return [user, host].filter((part) => part !== "").join("@");
}

/**
 * Live auto-fill: stamp the derived name onto the draft unless the user has
 * taken over the name field (`nameTouched`). With nothing to derive — a
 * SQLite draft before a file is chosen — a previously auto-filled value is
 * cleared rather than left stale (e.g. after switching engines).
 */
export function withDerivedName(draft: SessionDraft, nameTouched: boolean): SessionDraft {
  if (nameTouched) return draft;
  const derived = deriveSessionName(draft);
  if (derived === draft.name) return draft;
  return { ...draft, name: derived };
}

export function newDraft(engine: DbType = "mysql"): SessionDraft {
  const draft: SessionDraft = {
    id: crypto.randomUUID(),
    name: "",
    engine,
    ...ENGINE_DEFAULTS[engine],
    database: "",
    sslMode: engine === "sqlite" ? "disabled" : "preferred",
    sslCaPath: "",
    sslCertPath: "",
    sslKeyPath: "",
    useSsh: false,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    authMethod: "password",
    keyPath: "",
    passphrase: "",
    group: "",
    color: null,
    comment: "",
    keepAliveSec: "",
    txMode: "",
    isolationDefault: "",
  };
  return withDerivedName(draft, false);
}

/**
 * Switch engines in place, applying that engine's defaults for the
 * untouched connection fields while keeping name/id/SSH settings.
 */
export function draftWithEngine(draft: SessionDraft, engine: DbType): SessionDraft {
  if (draft.engine === engine) return draft;
  const defaults = ENGINE_DEFAULTS[engine];
  return {
    ...draft,
    engine,
    host: defaults.host,
    port: defaults.port,
    user: defaults.user,
    sslMode: engine === "sqlite" ? "disabled" : "preferred",
    sslCaPath: "",
    sslCertPath: "",
    sslKeyPath: "",
    useSsh: engine === "sqlite" ? false : draft.useSsh,
  };
}

export function draftFromSession(session: SavedSession): SessionDraft {
  return {
    id: session.id,
    name: session.name,
    engine: session.dbType,
    host: session.host,
    port: session.port,
    user: session.user,
    database: session.database ?? "",
    sslMode: session.sslMode,
    useSsh: session.useSsh,
    sslCaPath: session.ssl?.caPath ?? "",
    sslCertPath: session.ssl?.certPath ?? "",
    sslKeyPath: session.ssl?.keyPath ?? "",
    sshHost: session.ssh?.host ?? "",
    sshPort: session.ssh?.port ?? 22,
    sshUser: session.ssh?.user ?? "",
    authMethod: session.ssh?.auth.method === "key" ? "key" : "password",
    keyPath: session.ssh?.auth.method === "key" ? session.ssh.auth.keyPath : "",
    passphrase: session.ssh?.auth.method === "key" ? (session.ssh.auth.passphrase ?? "") : "",
    group: session.group ?? "",
    color: session.color ?? null,
    comment: session.comment ?? "",
    keepAliveSec: session.keepAliveSec ?? "",
    txMode: session.txMode ?? "",
    isolationDefault: session.isolation ?? "",
  };
}

/**
 * Convert the flat draft into the wire shape. `useSsh` without a configured
 * SSH host is rejected by validation before this point.
 */
export function draftToSession(draft: SessionDraft): SavedSession {
  const sqlite = draft.engine === "sqlite";
  return {
    id: draft.id,
    name: draft.name.trim(),
    dbType: draft.engine,
    // SQLite keeps the FILE path in `host`; server engines keep host/port/user.
    host: draft.host.trim(),
    port: sqlite ? 0 : draft.port,
    user: sqlite ? "" : draft.user.trim(),
    database: draft.database.trim() === "" ? null : draft.database.trim(),
    sslMode: sqlite ? "disabled" : draft.sslMode,
    useSsh: !sqlite && draft.useSsh,
    ssl:
      !sqlite &&
      (draft.sslCaPath.trim() || draft.sslCertPath.trim() || draft.sslKeyPath.trim())
        ? {
            caPath: draft.sslCaPath.trim() || null,
            certPath: draft.sslCertPath.trim() || null,
            keyPath: draft.sslKeyPath.trim() || null,
          }
        : null,
    ssh: !sqlite && draft.useSsh
      ? {
          host: draft.sshHost.trim(),
          port: draft.sshPort,
          user: draft.sshUser.trim(),
          auth:
            draft.authMethod === "key"
              ? { method: "key", keyPath: draft.keyPath.trim(), passphrase: draft.passphrase }
              : { method: "password", password: "" },
        }
      : null,
    group: draft.group.trim() === "" ? null : draft.group.trim(),
    color: draft.color,
    comment: draft.comment.trim() === "" ? null : draft.comment.trim(),
    keepAliveSec: draft.keepAliveSec === "" ? null : draft.keepAliveSec,
    // Transactions defaults are server-engine only — SQLite never carries them.
    txMode: sqlite ? null : draft.txMode === "" ? null : draft.txMode,
    isolation: sqlite ? null : draft.isolationDefault === "" ? null : draft.isolationDefault,
  };
}

/** Only non-empty secret strings are sent (blank = keep stored value). */
export function secretsForWire(secrets: DraftSecrets) {
  const password = secrets.password === "" ? undefined : secrets.password;
  const sshPassword = secrets.sshPassword === "" ? undefined : secrets.sshPassword;
  return { password, sshPassword };
}

export function validateDraft(draft: SessionDraft, secrets: DraftSecrets): string | null {
  if (draft.name.trim() === "") return "Session name is required.";

  if (draft.engine === "sqlite") {
    if (draft.host.trim() === "") return "Database file path is required.";
    return validateKeepAlive(draft);
  }

  if (draft.host.trim() === "") return "Host is required.";
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) {
    return "Port must be between 1 and 65535.";
  }
  if (draft.user.trim() === "") return "User is required.";

  const keepAliveError = validateKeepAlive(draft);
  if (keepAliveError) return keepAliveError;

  if (draft.useSsh) {
    if (draft.sshHost.trim() === "") return "SSH host is required.";
    if (!Number.isInteger(draft.sshPort) || draft.sshPort < 1 || draft.sshPort > 65_535) {
      return "SSH port must be between 1 and 65535.";
    }
    if (draft.sshUser.trim() === "") return "SSH user is required.";
    if (draft.authMethod === "key" && draft.keyPath.trim() === "") {
      return "Private key path is required.";
    }
    if (
      draft.authMethod === "password" &&
      secrets.sshPassword === ""
    ) {
      return "SSH password is required (or switch to key auth).";
    }
  }
  return null;
}

/** Keep-alive bounds: 0–86400 s or unset (backend caps at one day anyway). */
function validateKeepAlive(draft: SessionDraft): string | null {
  if (draft.keepAliveSec === "") return null;
  if (!Number.isInteger(draft.keepAliveSec) || draft.keepAliveSec < 0 || draft.keepAliveSec > 86_400) {
    return "Keep-alive must be between 0 and 86400 seconds.";
  }
  return null;
}
