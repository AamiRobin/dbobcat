import { describe, expect, test } from "bun:test";

import type { SavedSession } from "@/types/ipc";

import {
  draftFromSession,
  draftToSession,
  draftWithEngine,
  isServerEngine,
  newDraft,
  validateDraft,
} from "./session-draft";

const baseMysql = (): SavedSession => ({
  id: "s1",
  name: "Local",
  dbType: "mysql",
  host: "10.0.0.5",
  port: 3307,
  user: "admin",
  database: "shop",
  sslMode: "preferred",
  useSsh: false,
  ssh: null,
});

describe("engine marshaling", () => {
  test("new drafts default to mysql and engine defaults apply", () => {
    const mysql = newDraft();
    expect(mysql.engine).toBe("mysql");
    expect(mysql.port).toBe(3306);
    expect(mysql.user).toBe("root");

    const pg = newDraft("postgres");
    expect(pg.port).toBe(5432);
    expect(pg.user).toBe("postgres");

    const lite = newDraft("sqlite");
    expect(lite.host).toBe("");
    expect(lite.port).toBe(0);
    expect(lite.sslMode).toBe("disabled");
  });

  test("draftToSession keeps the wire shape for server engines", () => {
    const draft = draftFromSession(baseMysql());
    const wire = draftToSession(draft);
    expect(wire.dbType).toBe("mysql");
    expect(wire.host).toBe("10.0.0.5");
    expect(wire.port).toBe(3307);
    expect(wire.user).toBe("admin");
    expect(wire.database).toBe("shop");
    expect(wire.useSsh).toBe(false);
    expect(wire.ssh).toBeNull();
  });

  test("sqlite sessions carry the file path and drop server fields", () => {
    const draft = draftWithEngine(draftFromSession(baseMysql()), "sqlite");
    draft.host = "/data/app.sqlite";
    draft.name = "Local file";
    const wire = draftToSession(draft);

    expect(wire.dbType).toBe("sqlite");
    expect(wire.host).toBe("/data/app.sqlite");
    expect(wire.port).toBe(0);
    expect(wire.user).toBe("");
    expect(wire.sslMode).toBe("disabled");
    expect(wire.useSsh).toBe(false);
    expect(wire.ssh).toBeNull();

    // Round-trip: loading the saved session keeps the path in `host`.
    const reloaded = draftFromSession(wire);
    expect(reloaded.engine).toBe("sqlite");
    expect(reloaded.host).toBe("/data/app.sqlite");
  });

  test("switching engines applies that engine's defaults but keeps identity", () => {
    const original = draftFromSession(baseMysql());
    original.name = "My server";
    const pg = draftWithEngine(original, "postgres");
    expect(pg.id).toBe(original.id);
    expect(pg.name).toBe("My server");
    expect(pg.port).toBe(5432);
    expect(pg.user).toBe("postgres");

    // Switching back to the same engine is a no-op.
    expect(draftWithEngine(pg, "postgres")).toBe(pg);
  });
});

describe("per-engine validation", () => {
  test("sqlite requires a file path only", () => {
    const draft = draftWithEngine(newDraft("sqlite"), "sqlite");
    draft.name = "Local file";
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(
      /file path is required/i,
    );

    draft.host = "/tmp/x.db";
    // No host/port/user checks for local files.
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toBeNull();
  });

  test("server engines keep the host/port/user rules", () => {
    const draft = newDraft("mysql");
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(/name is required/i);

    draft.name = "x";
    draft.host = "";
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(/host is required/i);

    draft.host = "127.0.0.1";
    draft.port = 99_999;
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(/between 1 and 65535/i);

    draft.port = 3306;
    draft.user = "";
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(/user is required/i);

    draft.user = "root";
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toBeNull();
  });
});

describe("helpers", () => {
  test("isServerEngine separates sqlite", () => {
    expect(isServerEngine("mysql")).toBe(true);
    expect(isServerEngine("postgres")).toBe(true);
    expect(isServerEngine("sqlite")).toBe(false);
  });
});

describe("phase 9-B metadata marshaling", () => {
  test("group/color/comment/keepAliveSec round-trip", () => {
    const saved: SavedSession = {
      ...baseMysql(),
      group: "Work / Prod",
      color: "#3b82f6",
      comment: "primary cluster",
      keepAliveSec: 30,
    };
    const wire = draftToSession(draftFromSession(saved));
    expect(wire.group).toBe("Work / Prod");
    expect(wire.color).toBe("#3b82f6");
    expect(wire.comment).toBe("primary cluster");
    expect(wire.keepAliveSec).toBe(30);
  });

  test("blank strings marshal to null and unset keep-alive stays null", () => {
    const draft = draftFromSession(baseMysql());
    draft.group = "   ";
    draft.comment = "";
    const wire = draftToSession(draft);
    expect(wire.group).toBeNull();
    expect(wire.comment).toBeNull();
    expect(wire.keepAliveSec).toBeNull();
  });

  test("keep-alive validation bounds", () => {
    const draft = newDraft("mysql");
    draft.name = "x";
    draft.keepAliveSec = -1;
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(/keep-alive/i);

    draft.keepAliveSec = 86_401;
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toMatch(/keep-alive/i);

    draft.keepAliveSec = 0;
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toBeNull();

    draft.keepAliveSec = 86_400;
    expect(validateDraft(draft, { password: "", sshPassword: "" })).toBeNull();
  });
});

describe("transactions defaults marshaling (Phase 1)", () => {
  test("txMode/isolation round-trip on server engines", () => {
    const saved: SavedSession = {
      ...baseMysql(),
      txMode: "manual",
      isolation: "repeatable_read",
    };
    const wire = draftToSession(draftFromSession(saved));
    expect(wire.txMode).toBe("manual");
    expect(wire.isolation).toBe("repeatable_read");

    // Round-trip through the draft again keeps the values.
    const reloaded = draftFromSession(wire);
    expect(reloaded.txMode).toBe("manual");
    expect(reloaded.isolationDefault).toBe("repeatable_read");
  });

  test("unset tx defaults stay null; new drafts start unset", () => {
    const wire = draftToSession(draftFromSession(baseMysql()));
    expect(wire.txMode).toBeNull();
    expect(wire.isolation).toBeNull();

    const fresh = newDraft("postgres");
    expect(fresh.txMode).toBe("");
    expect(fresh.isolationDefault).toBe("");
    const freshWire = draftToSession(fresh);
    expect(freshWire.txMode).toBeNull();
    expect(freshWire.isolation).toBeNull();
  });

  test("SQLite sessions never carry tx defaults", () => {
    const draft = draftWithEngine(
      draftFromSession({ ...baseMysql(), txMode: "manual", isolation: "serializable" }),
      "sqlite",
    );
    // Engine switch keeps the field values, but the SQLite wire shape drops them.
    const wire = draftToSession(draft);
    expect(wire.dbType).toBe("sqlite");
    expect(wire.txMode).toBeNull();
    expect(wire.isolation).toBeNull();
  });
});
