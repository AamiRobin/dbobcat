/**
 * Updater store concurrency: check dedup, handle supersession, install races.
 *
 * The Update handle lives in module scope, so these tests run as one ordered
 * story — each picks up where the previous one ended (call counts are
 * snapshotted relative to the start of each test). The Tauri updater/dialog/
 * process plugins and the toast+log sinks are mocked; the mocks must register
 * before the store's static imports evaluate, hence the dynamic import.
 */
import { describe, expect, mock, test } from "bun:test";

const notifyMock = {
  info: mock((_text: string) => {}),
  success: mock((_text: string) => {}),
  error: mock((_text: string) => {}),
  warning: mock((_text: string) => {}),
};
const logMock = mock((_level: string, _message: string) => {});
const confirmMock = mock(() => Promise.resolve(false));
const relaunchMock = mock(() => Promise.resolve());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One pending feed response per plugin check() call, in order. */
const feed: Array<ReturnType<typeof deferred<FakeUpdate | null>>> = [];
const feedCheck = mock(() => {
  const d = deferred<FakeUpdate | null>();
  feed.push(d);
  return d.promise;
});

interface FakeUpdate {
  version: string;
  close: ReturnType<typeof mock<() => Promise<void>>>;
  downloadAndInstall: ReturnType<typeof mock<() => Promise<void>>>;
  /** Scripted outcomes, consumed one per call; unscripted calls hang. */
  downloads: Array<Promise<void>>;
}

function fakeUpdate(version: string): FakeUpdate {
  const u = {} as FakeUpdate;
  Object.assign(u, {
    version,
    close: mock(() => Promise.resolve()),
    downloadAndInstall: mock(
      (onEvent?: (event: { event: string; data: Record<string, unknown> }) => void) => {
        const outcome = u.downloads.shift() ?? new Promise<void>(() => {});
        return outcome.then(() => {
          onEvent?.({ event: "Finished", data: {} });
        });
      },
    ),
    downloads: [] as Array<Promise<void>>,
  });
  return u;
}

mock.module("@/lib/toast", () => ({ notify: notifyMock }));
mock.module("@/stores/log", () => ({ log: logMock }));
mock.module("@tauri-apps/plugin-updater", () => ({ check: feedCheck }));
mock.module("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));
mock.module("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));

const { useUpdaterStore } = await import("@/stores/updater");

const S = () => useUpdaterStore.getState();
const infoMessages = () => notifyMock.info.mock.calls.map((c) => String(c[0]));
const successMessages = () => notifyMock.success.mock.calls.map((c) => String(c[0]));
const errorMessages = () => notifyMock.error.mock.calls.map((c) => String(c[0]));

/**
 * The store reaches the feed only after its dynamic plugin import settles, so
 * yield the event loop until `count` feed entries have piled up.
 */
async function waitForFeed(count: number) {
  for (let i = 0; i < 100 && feed.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(feed.length).toBeGreaterThanOrEqual(count);
}

/** The handle the store currently holds (its module-side pendingUpdate). */
let handle: FakeUpdate;

describe("updater store", () => {
  test("concurrent checks of the same mode hit the feed once", async () => {
    const p1 = S().check({ silent: true });
    const p2 = S().check({ silent: true });
    await waitForFeed(1);
    expect(feedCheck).toHaveBeenCalledTimes(1);
    feed[0].resolve(null);
    await Promise.all([p1, p2]);
    expect(S().status).toBe("idle");
  });

  test("silent and manual checks fetch separately; silent feed errors stay quiet", async () => {
    const checksBefore = feed.length;
    const ps = S().check({ silent: true });
    const pm = S().check({ silent: false });
    await waitForFeed(checksBefore + 2);
    expect(feedCheck).toHaveBeenCalledTimes(checksBefore + 2);
    feed[checksBefore].reject(new Error("no updater config"));
    feed[checksBefore + 1].resolve(null);
    await Promise.all([ps, pm]);
    expect(S().status).toBe("idle");
    expect(logMock).not.toHaveBeenCalled(); // silent failure: no warn
    expect(infoMessages()).toContain("You are up to date."); // manual: toasted
  });

  test("a found update is announced once; a re-check supersedes the old handle", async () => {
    const before = feed.length;
    handle = fakeUpdate("9.9.9");
    const p1 = S().check({ silent: true });
    await waitForFeed(before + 1);
    feed[before].resolve(handle);
    await p1;
    expect(S().status).toBe("available");
    expect(S().version).toBe("9.9.9");
    expect(infoMessages().filter((m) => m.includes("9.9.9"))).toHaveLength(1);

    // The other mode finds the same version: old handle closed, fresh one
    // kept, and no second availability toast.
    const u2 = fakeUpdate("9.9.9");
    const p2 = S().check({ silent: false });
    await waitForFeed(before + 2);
    feed[before + 1].resolve(u2);
    await p2;
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(u2.close).not.toHaveBeenCalled();
    expect(infoMessages().filter((m) => m.includes("9.9.9"))).toHaveLength(1);
    handle = u2;
  });

  test("install downloads once despite double-click; a mid-download check is a no-op", async () => {
    const dl = deferred<void>();
    handle.downloads.push(dl.promise);
    const i1 = S().install();
    const i2 = S().install();
    expect(handle.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(S().status).toBe("downloading");

    const checksBefore = feedCheck.mock.calls.length;
    const toastsBefore = infoMessages().length;
    await S().check({ silent: true });
    expect(feedCheck).toHaveBeenCalledTimes(checksBefore); // no refetch
    expect(S().status).toBe("downloading"); // no clobber
    expect(infoMessages()).toHaveLength(toastsBefore); // no toast

    dl.resolve();
    await Promise.all([i1, i2]);
    expect(S().status).toBe("ready");
    expect(S().progress).toBe(100);
    expect(successMessages().some((m) => m.includes("9.9.9"))).toBe(true);
    expect(relaunchMock).not.toHaveBeenCalled(); // confirm declines by default
  });

  test("a check after a declined restart reports instead of refetching", async () => {
    const checksBefore = feedCheck.mock.calls.length;
    await S().check({ silent: false });
    expect(feedCheck).toHaveBeenCalledTimes(checksBefore);
    expect(S().status).toBe("ready");
    const lastInfo = infoMessages();
    expect(lastInfo[lastInfo.length - 1]).toMatch(/already installed/i);
  });

  test("a failed download returns to available with an error toast", async () => {
    handle.downloads.push(Promise.reject(new Error("network gone")));
    await S().install();
    expect(S().status).toBe("available");
    expect(S().progress).toBeNull();
    expect(errorMessages().some((m) => m.includes("network gone"))).toBe(true);
  });

  test("a failed restart prompt keeps the update ready and logs a warning", async () => {
    handle.downloads.push(Promise.resolve());
    confirmMock.mockImplementationOnce(() => Promise.reject(new Error("dialog failed")));
    await S().install();
    expect(S().status).toBe("ready");
    expect(
      logMock.mock.calls.some(([, msg]) => String(msg).includes("restart prompt failed")),
    ).toBe(true);
  });
});
