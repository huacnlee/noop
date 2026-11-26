// Vendored from https://github.com/huacnlee/nsmetry sdk/nsh/src (commit 35f6d75, MIT).
// Replace this folder with `nsh add nsmetry` once the nsmetry crate is on crates.io.
/**
 * `nsmetry` for NSH apps: event analytics sent to a self-hosted NsMetry
 * instance, batched to fit Cloudflare's free plan.
 *
 * The queue, batching and retries are ./core.ts, shared verbatim with the npm
 * package. This file is the NSH platform: `Storage` for the persisted
 * anonymous id, `appInfo()` for the version, `platform` for the OS and device
 * class, `lifecycle()` for flushing when the app goes to the background, and a
 * hook that turns navigation into screen views.
 */
import { appInfo, effect, lifecycle, platform, Storage, untracked, windowSize, type PlatformInfo } from "nsh";
import type { NavStackState } from "nsh/base";
import { Application } from "nsh/desktop";
import { createClient, SDK_VERSION, type NsMetry, type NsMetryOptions, type Platform } from "./core";

export type { KeyValueStorage, NsMetry, NsMetryOptions, PropValue, Props, WireEvent } from "./core";
export { SDK_VERSION, sanitizeProps } from "./core";

/** The parts of `platform` the user-agent description reads. */
export type PlatformDescription = Pick<PlatformInfo, "os" | "version" | "idiom">;

/**
 * The `ua` the server's parser reads the OS and device class from, or
 * undefined on the web, where the browser's own User-Agent header is right.
 *
 * The words are the ones src/ua.ts looks for: `iPhone`/`iPad` and `iOS`,
 * `Android` with `Mobile` (phone) or without it (tablet), `macOS`,
 * `Windows NT`, `Linux`. The app's name is left out on purpose: a name such as
 * "Disk Monitor" or "Quick Preview" would trip the server's bot filter.
 */
export function describePlatform(info: PlatformDescription): string | undefined {
  const base = `NsMetry-NSH/${SDK_VERSION}`;
  const version = info.version && info.version !== "0.0" ? ` ${info.version}` : "";
  switch (info.os) {
    case "web":
      return undefined;
    case "ios":
      if (info.idiom === "pad") return `${base} (iPad; iOS${version}; Tablet)`;
      // Mac Catalyst in the Mac idiom: a Mac to the person using it.
      if (info.idiom === "mac") return `${base} (macOS${version})`;
      if (info.idiom === "phone") return `${base} (iPhone; iOS${version}; Mobile)`;
      return `${base} (iOS${version})`;
    case "android":
      // Android API level, not the marketing version: still the word Android.
      return info.idiom === "pad" ? `${base} (Android${version}; Tablet)` : `${base} (Android${version}; Mobile)`;
    case "macos":
      return `${base} (macOS${version})`;
    case "windows":
      return `${base} (Windows NT${version})`;
    case "linux":
      return `${base} (Linux)`;
    default:
      return base;
  }
}

function nshPlatform(): Platform {
  return {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as number),
    storage: Storage,
    // No beacon: an NSH app keeps running for a moment in the background, so
    // an ordinary fetch is the way out. Backgrounding is `useNsMetry`'s job:
    // `lifecycle()` is a signal and needs a component to own its effect.
    beacon: undefined,
    onHide: undefined,
    ua: () => describePlatform(platform),
    currentPath: undefined,
    // The window's width, which on phones is the screen's; the server only
    // keeps a coarse bucket (phone, tablet, laptop, desktop) of it.
    screenWidth: () => untracked(() => windowSize().width),
    randomId: () => crypto.randomUUID(),
  };
}

/**
 * Creates a client. `appVersion` defaults to the app's own (`nsh.json`
 * `"version"`, or the one `nsh package` was given). Never throws.
 *
 * ```ts
 * export const nsmetry = createNsMetry({ endpoint: "https://stats.example.com", site: "my-app", persistUserId: true });
 * ```
 */
export function createNsMetry(options: NsMetryOptions): NsMetry {
  let appVersion = options.appVersion;
  if (appVersion === undefined) {
    try {
      appVersion = appInfo().version ?? undefined;
    } catch {
      // A host without app info: no version.
    }
  }
  return createClient({ ...options, appVersion }, nshPlatform());
}

/**
 * Flushes when the app goes to the background (`lifecycle()`), the last
 * moment a phone reliably lets it send, and when a desktop app quits
 * (`Application.on("quit")`, which waits up to 200 ms for the request; on
 * the web that is the page going away). Call it once, in the root component:
 * the effects belong to that component and stop with it.
 *
 * Only `"background"` flushes. `"inactive"` comes and goes with every window
 * focus change on a desktop, and flushing on each would spend requests.
 */
export function useNsMetry(client: NsMetry): void {
  effect(() => {
    if (lifecycle() === "background") void client.flush();
  });
  // A desktop app is rarely backgrounded the way a phone app is: it is quit,
  // and without this the last ≤ 5 minutes of events would go with it. Best effort:
  // NSH waits at most 200 ms for quit listeners, so a slow network loses the
  // race (the headless test runner cannot answer requests inside that wait,
  // so no test covers it). The effect reads no signal, so it runs once; its
  // cleanup stops listening.
  effect(() => {
    try {
      return Application.on("quit", () => client.flush());
    } catch {
      // A host without the application module: nothing to listen to.
      return undefined;
    }
  });
}

/**
 * Records a screen view each time `path()` gives a new path: a route signal,
 * a tab's value, anything reactive. `null` or `undefined` records nothing.
 * Call it in a component; the effect stops with it.
 *
 * ```ts
 * useScreenTracking(nsmetry, () => `/${tab()}`);
 * ```
 */
export function useScreenTracking(client: NsMetry, path: () => string | null | undefined): void {
  let last: string | undefined;
  effect(() => {
    const next = path();
    if (typeof next !== "string" || next === "" || next === last) return;
    last = next;
    untracked(() => client.screen(next));
  });
}

/**
 * The path of a `<NavStack>`'s top page, for `useScreenTracking`. `toPath`
 * maps a route to a path such as `/message`; keep ids out of it unless you
 * want one row per id in the dashboard (they cost a row each, too).
 *
 * ```ts
 * useScreenTracking(nsmetry, navStackPath(nav, (r) => `/${r.name}`));
 * ```
 */
export function navStackPath<R>(stack: NavStackState<R>, toPath: (route: R) => string | null | undefined): () => string | null | undefined {
  return () => {
    const routes = stack.routes();
    const top = routes[routes.length - 1];
    return top === undefined ? undefined : toPath(top);
  };
}
