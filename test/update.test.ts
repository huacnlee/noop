import { expect, test } from "bun:test";
import { createUpdates, type FoundUpdate, type UpdateState, type UpdaterApi } from "../app/update";

function setup(found: FoundUpdate | null) {
  const states: UpdateState[] = [];
  const calls: string[] = [];
  const api: UpdaterApi = {
    check: async () => { calls.push("check"); return found; },
    download: async () => { calls.push("download"); },
    install: async () => { calls.push("install"); },
  };
  return { api, calls, states, last: () => states[states.length - 1], updates: createUpdates(api, (s) => states.push(s)) };
}
const update = { version: "1.2.0", url: "https://example.com/a.tar.gz", canInstall: true };

test("an update is downloaded before anything shows, and only a press installs it", async () => {
  const t = setup(update);
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download"]);
  expect(t.states).toEqual([{ kind: "ready", version: "1.2.0" }]);
  await t.updates.install();
  expect(t.calls).toEqual(["check", "download", "install"]);
});

test("checking again does not drop a download that waits for its restart", async () => {
  const t = setup(update);
  await t.updates.check();
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download", "check"]);
});

test("a newer release while one waits for its restart replaces it", async () => {
  const t = setup(update);
  await t.updates.check();
  t.api.check = async () => { t.calls.push("check"); return { ...update, version: "1.3.0" }; };
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download", "check", "download"]);
  expect(t.last()).toEqual({ kind: "ready", version: "1.3.0" });
});

test("an update the app cannot install is a link, with no download", async () => {
  const t = setup({ ...update, canInstall: false });
  await t.updates.check();
  expect(t.calls).toEqual(["check"]);
  expect(t.last()).toEqual({ kind: "link", version: "1.2.0", url: update.url });
});

test("up to date shows nothing", async () => {
  const t = setup(null);
  await t.updates.check();
  expect(t.states).toEqual([]);
  await t.updates.install();
  expect(t.calls).toEqual(["check"]);
});

test("a failed check or download stays quiet, and the next check tries again", async () => {
  const t = setup(update);
  const download = t.api.download;
  t.api.download = async () => { throw new Error("offline"); };
  await t.updates.check();
  expect(t.states).toEqual([]);
  t.api.download = download;
  await t.updates.check();
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0" });
});

test("a failed install says why and can be pressed again", async () => {
  const t = setup(update);
  await t.updates.check();
  const install = t.api.install;
  t.api.install = async () => { throw new Error("no space"); };
  await t.updates.install();
  expect(t.last()).toEqual({ kind: "failed", version: "1.2.0", message: "no space" });
  t.api.install = install;
  await t.updates.install();
  expect(t.states.map((s) => s.kind)).toEqual(["ready", "installing", "failed", "installing"]);
});

function withPackages(found: { version: string; build: number } | null, restart = true) {
  const t = setup(update);
  const packages = {
    check: async () => { t.calls.push("pkg-check"); return found; },
    download: async () => { t.calls.push("pkg-download"); },
    restart: restart ? async () => { t.calls.push("pkg-restart"); } : null,
  };
  const api = { ...t.api, packages };
  const updates = createUpdates(api, (s) => t.states.push(s));
  return { ...t, api, packages, updates };
}
const pkg = { version: "1.2.0", build: 42 };

test("a package is preferred over the whole app, and a press restarts into it", async () => {
  const t = withPackages(pkg);
  t.api.check = async () => { t.calls.push("check"); return null; };
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "check"]);
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0", package: true });
  await t.updates.install();
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "check", "pkg-restart"]);
});

test("where the app cannot restart itself a package is staged silently for the next launch", async () => {
  const t = withPackages(pkg, false);
  t.api.check = async () => { t.calls.push("check"); return null; };
  await t.updates.check();
  expect(t.last()).toEqual({ kind: "staged", version: "1.2.0" });
  await t.updates.install();
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "check"]);
  await t.updates.check(); // the same package is not downloaded again
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "check", "pkg-check", "check"]);
});

test("with no package this runtime can run, the whole app updates as before", async () => {
  const t = withPackages(null);
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "check", "download"]);
  expect(t.last()).toEqual({ kind: "ready", version: "1.2.0" });
  await t.updates.install();
  expect(t.calls.at(-1)).toBe("install");
});

test("a failed package download falls back to the app check, and a failed restart retries the package", async () => {
  const t = withPackages(pkg);
  t.packages.download = async () => { throw new Error("bad signature"); };
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "check", "download"]);
  const t2 = withPackages(pkg);
  t2.api.check = async () => null;
  await t2.updates.check();
  t2.packages.restart = async () => { throw new Error("busy"); };
  await t2.updates.install();
  expect(t2.last()).toEqual({ kind: "failed", version: "1.2.0", message: "busy", package: true });
});

test("a running OTA no longer suppresses the shell update reported by NSH", async () => {
  const t = withPackages(null);
  t.api.check = async () => ({ ...update, shell: true });
  await t.updates.check();
  expect(t.last()).toMatchObject({ kind: "shell", phase: "available", version: update.version });
  expect(t.calls).toEqual(["pkg-check"]);
});

test("OTA downloads first; the shell waits for a press, reports progress and restarts", async () => {
  const t = withPackages(pkg);
  t.api.download = async (progress) => { t.calls.push("download"); progress?.(42); };
  await t.updates.check();
  expect(t.calls).toEqual(["pkg-check", "pkg-download", "check"]);
  expect(t.last()).toMatchObject({ kind: "shell", phase: "available" });
  await t.updates.check();
  expect(t.calls.filter(c => c === "pkg-download").length).toBe(1);
  await t.updates.installShell();
  expect(t.calls.slice(-2)).toEqual(["download", "install"]);
  expect(t.states).toContainEqual({ kind: "shell", version: update.version, url: update.url, canInstall: true, phase: "downloading", progress: 42, message: undefined });
  expect(t.last()).toMatchObject({ kind: "shell", phase: "installing" });
});

test("Android and iOS shell links open only on request, without native download or install", async () => {
  for (const url of ["https://example.com/noop.apk", "https://apps.apple.com/app/id123"]) {
    const t = setup({ ...update, url, canInstall: false, shell: true });
    t.api.open = async (target) => { t.calls.push(target); };
    await t.updates.check();
    expect(t.calls).toEqual(["check"]);
    await t.updates.installShell();
    expect(t.calls).toEqual(["check", url]);
  }
});

test("shell download failure is visible and retryable, and duplicate presses are ignored", async () => {
  const t = setup({ ...update, shell: true });
  await t.updates.check();
  t.api.download = async () => { throw new Error("offline"); };
  await t.updates.installShell();
  expect(t.last()).toMatchObject({ kind: "shell", phase: "failed", message: "offline" });
  let finish!: () => void;
  t.api.download = async () => { t.calls.push("download"); await new Promise<void>(resolve => { finish = resolve; }); };
  const installing = t.updates.installShell();
  await t.updates.installShell();
  await t.updates.check();
  expect(t.calls).toEqual(["check", "download"]);
  finish();
  await installing;
  expect(t.calls).toEqual(["check", "download", "install"]);
});

test("a new OTA build of the same version is still downloaded while shell waits", async () => {
  const t = withPackages(pkg);
  await t.updates.check();
  t.packages.check = async () => ({ ...pkg, build: 43 });
  await t.updates.check();
  expect(t.calls.filter(c => c === "pkg-download").length).toBe(2);
});

test("shell line: version, build and NSH; a phone shell without packages says to reinstall", async () => {
  const { shellLine } = await import("../app/update");
  const info = { version: "0.2.1", build: 35, nshVersion: "0.4.0", packages: true };
  expect(shellLine(info, "ios")).toEqual({ text: "0.2.1 (35) · NSH 0.4.0", tone: "ok" });
  expect(shellLine({ ...info, version: null, build: null, packages: false }, "linux")).toEqual({ text: "dev · NSH 0.4.0", tone: "ok" });
  // a runtime without shellInfo says nothing either way
  expect(shellLine(undefined, "ios")).toBeNull();
  expect(shellLine(undefined, "macos")).toBeNull();
  expect(shellLine({ ...info, packages: false }, "android")).toEqual({ text: "no-packages", tone: "bad" });
});

test("a failed shell check preserves the verified OTA for the next launch", async () => {
  const t = withPackages(pkg, false);
  t.api.check = async () => { throw new Error("offline"); };
  await t.updates.check();
  expect(t.last()).toEqual({ kind: "staged", version: pkg.version });
  expect(t.calls).toEqual(["pkg-check", "pkg-download"]);
});

test("on a phone a shell the app cannot install is never a store link in the sidebar", async () => {
  const t = withPackages(null, false);
  t.api.check = async () => ({ ...update, canInstall: false, url: "https://apps.apple.com/app/id123" });
  await t.updates.check();
  expect(t.last()).toMatchObject({ kind: "shell", phase: "available", version: "1.2.0" });
});

test("check now runs the OTA flow and says what it found", async () => {
  const ready = withPackages(pkg, false);
  ready.api.check = async () => null;
  expect(await ready.updates.checkNow()).toBe("ready");
  const latest = withPackages(null);
  latest.api.check = async () => null;
  expect(await latest.updates.checkNow()).toBe("latest");
  const failed = withPackages(null);
  failed.api.check = async () => { throw new Error("offline"); };
  expect(await failed.updates.checkNow()).toBe("failed");
  const shell = withPackages(null, false);
  shell.api.check = async () => ({ ...update, canInstall: false });
  expect(await shell.updates.checkNow()).toBe("shell");
});
