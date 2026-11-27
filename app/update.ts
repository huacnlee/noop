// OTA downloads quietly; optional shell downloads start only on request. Nothing interrupts the user.
// No UI or I/O of its own: nsh/updater is passed in.
//
// A release ships two ways. A signed package (.nshpkg) carries only the app's TSX and reaches every installed app,
// iOS and Android included, with no store build: it is downloaded and verified in the background and runs from the
// next launch on, so on a phone the update is silent. Only a release that needs a newer NSH runtime than the
// installed app has needs a whole app. When the package already covers the code, the shell is an optional update.

export type FoundUpdate = { version: string; url: string; canInstall: boolean; shell?: boolean };
export type FoundPackage = { version: string; build: number };

export type PackageApi = {
  /** A newer package this runtime can run, or null. */
  check: () => Promise<FoundPackage | null>;
  /** Downloads and verifies it; it runs from the next launch. */
  download: () => Promise<void>;
  /** Restarts into it now; null where the platform cannot restart an app (iOS, Android). */
  restart: (() => Promise<void>) | null;
};

export type UpdaterApi = {
  check: () => Promise<FoundUpdate | null>;
  download: (progress?: (value: number | null) => void) => Promise<void>;
  install: () => Promise<void>;
  open?: (url: string) => Promise<void>;
  packages?: PackageApi;
};

export type UpdateState =
  | { kind: "none" }
  | { kind: "shell"; version: string; url: string; canInstall: boolean; phase: "available" | "downloading" | "installing" | "failed"; progress?: number | null; message?: string }
  /** Downloaded and verified: a restart applies it (a package's restart when `package`). */
  | { kind: "ready"; version: string; package?: true }
  /** A package downloaded where the app cannot restart itself: it runs from the next launch, nothing to press. */
  | { kind: "staged"; version: string }
  /** The app cannot replace itself (Android, a system package): the owner gets it from the link. */
  | { kind: "link"; version: string; url: string }
  | { kind: "installing"; version: string }
  | { kind: "failed"; version: string; message: string; package?: true };

export const CHECK_EVERY_MS = 60 * 60 * 1000;

export function createUpdates(api: UpdaterApi, onChange: (state: UpdateState) => void) {
  let state: UpdateState = { kind: "none" };
  let busy = false;
  let heldPackage: (FoundPackage & { state: UpdateState }) | null = null;
  let lastPackageError: unknown = null;
  const set = (next: UpdateState) => {
    state = next;
    onChange(next);
  };

  /** A failed check or download stays silent and the next tick tries again: a blip is not worth a banner. */
  async function check() {
    await run(false).catch(() => {});
  }

  /**
   * The Settings button: the same flow as the hourly check, but it says what happened. "ready" = an OTA package or
   * update is downloaded, "shell" = only a new app shell is available, "latest" = nothing newer.
   */
  async function checkNow(): Promise<"ready" | "shell" | "latest" | "failed"> {
    try {
      if (busy) return "latest";
      lastPackageError = null;
      await run(true);
    } catch {
      return "failed";
    }
    const k = (state as UpdateState).kind;
    return k === "ready" || k === "staged" ? "ready" : k === "shell" || k === "link" ? "shell" : k === "failed" || lastPackageError ? "failed" : "latest";
  }

  async function run(manual: boolean) {
    // A download waiting for its restart keeps being checked: a newer release replaces it, so the restart lands on
    // the latest instead of one version short (nsh/updater keeps the held download when the same version comes back).
    if (busy || state.kind === "installing" || state.kind === "failed" || (state.kind === "shell" && state.phase !== "available")) return;
    busy = true;
    let downloading = false;
    let packageState: UpdateState | null = null;
    try {
      packageState = await checkPackage();
      const found = await api.check();
      if (!found) { if (packageState || state.kind !== "none") set(packageState ?? { kind: "none" }); return; }
      // A staged OTA or a running package keeps the full shell update an explicit, optional action.
      if (packageState || found.shell) {
        set({ kind: "shell", version: found.version, url: found.url, canInstall: found.canInstall, phase: "available" });
        return;
      }
      // Phones (no in-app restart) never send the owner to a store: the store lags behind releases and code arrives
      // by OTA. A shell the app cannot install itself is the optional update next to the shell's version in Settings.
      if (!found.canInstall && api.packages && !api.packages.restart) {
        set({ kind: "shell", version: found.version, url: found.url, canInstall: false, phase: "available" });
        return;
      }
      if (!found.canInstall) return set({ kind: "link", version: found.version, url: found.url });
      if (state.kind === "ready" && state.version === found.version) return;
      downloading = true;
      await api.download();
      set({ kind: "ready", version: found.version });
    } catch (e) {
      console.warn("update check failed:", String(e));
      if (packageState) set(packageState);
      // A newer download that failed has already replaced the held one, so there is nothing left to restart into.
      if (downloading && state.kind === "ready") set({ kind: "none" });
      if (manual && !packageState) throw e;
    } finally {
      busy = false;
    }
  }

  /** Packages are checked first and cached by build as well as version. Shell checks do not trigger another OTA download. */
  async function checkPackage(): Promise<UpdateState | null> {
    const p = api.packages;
    if (!p) return null;
    try {
      const found = await p.check();
      if (!found) return heldPackage?.state ?? null;
      if (heldPackage?.version === found.version && heldPackage.build === found.build) return heldPackage.state;
      heldPackage = null;
      if (state.kind === "staged" || (state.kind === "ready" && state.package)) set({ kind: "none" });
      await p.download();
      const next: UpdateState = p.restart ? { kind: "ready", version: found.version, package: true } : { kind: "staged", version: found.version };
      heldPackage = { ...found, state: next };
      return next;
    } catch (e) {
      console.warn("package update failed:", String(e));
      lastPackageError = e;
      return null;
    }
  }

  async function installShell() {
    if (busy || state.kind !== "shell" || !["available", "failed"].includes(state.phase)) return;
    const found = state;
    busy = true;
    try {
      if (!found.canInstall) {
        if (!api.open) throw new Error("Cannot open the update link");
        await api.open(found.url);
        set({ ...found, phase: "available", message: undefined });
        return;
      }
      set({ ...found, phase: "downloading", progress: null, message: undefined });
      await api.download((progress) => set({ ...found, phase: "downloading", progress, message: undefined }));
      set({ ...found, phase: "installing", message: undefined });
      await api.install();
    } catch (e) {
      set({ ...found, phase: "failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
    }
  }

  /** Exits this run when it works; a failure leaves the app as it was, and the same download can be tried again. */
  async function install() {
    if (busy || (state.kind !== "ready" && state.kind !== "failed")) return;
    const { version } = state;
    const restart = state.package ? api.packages?.restart : null;
    set({ kind: "installing", version });
    try {
      await (restart ? restart() : api.install());
    } catch (e) {
      set({ kind: "failed", version, message: e instanceof Error ? e.message : String(e), ...(restart ? { package: true as const } : {}) });
    }
  }

  return { check, checkNow, install, installShell };
}

/** `nsh/updater`'s `shellInfo()`: the installed app (its shell) and the NSH runtime built into it. */
export type ShellInfo = { version: string | null; build: number | null; nshVersion: string; packages: boolean };

/**
 * The shell's line in the version list. `info` undefined: the runtime predates `shellInfo`, which says nothing about
 * whether it takes packages (shells from 0.2.1 do), so there is no line.
 */
export function shellLine(info: ShellInfo | undefined, os: string): { text: string; tone: "ok" | "bad" } | null {
  const phone = os === "ios" || os === "android";
  if (!info) return null;
  if (phone && !info.packages) return { text: "no-packages", tone: "bad" };
  return { text: `${info.version ?? "dev"}${info.build != null ? ` (${info.build})` : ""} · NSH ${info.nshVersion}`, tone: "ok" };
}
