import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { type Cfg, CODE, HOME_DIR, isPrimary } from "./core";

/**
 * Anonymous daily heartbeat so the Noop author can count active installs.
 *
 * Sent once a day, only by the primary machine, to the author's NsMetry instance (site `noop`, shared with the apps
 * and the website; the `/daemon` path keeps it apart). The event carries the Noop build date, the OS family and a
 * random install id kept on this machine; NsMetry hashes the id per site and keeps no IP.
 * No email, hub URL, machine name, repository or task content is ever sent.
 * Off with `[telemetry] enabled = false` in config.toml, `NOOP_TELEMETRY=0` or `DO_NOT_TRACK=1`.
 */
export const TELEMETRY_URL = "https://nsmetry.huacnlee-account.workers.dev/api/events/batch";
const SITE = "noop";
// machine-local, outside the synced data folder
const STAMP = () => join(HOME_DIR, "telemetry-last");
const ID = () => join(HOME_DIR, "telemetry-id");

export function telemetryEnabled(cfg: Cfg, env = process.env): boolean {
  if (env.DO_NOT_TRACK === "1" || /^(0|false|off|no)$/i.test(env.NOOP_TELEMETRY ?? "")) return false;
  return cfg.telemetry?.enabled !== false;
}

const osName = () => ({ darwin: "macOS", win32: "Windows NT 10.0", linux: "Linux" } as Record<string, string>)[process.platform] ?? "Other";

/** The build date of the running Noop (commit date of the install), e.g. 2026-11-26; "unknown" without git. */
export async function build(): Promise<string> {
  const r = await $`git log -1 --format=%cs`.cwd(CODE).quiet().nothrow();
  return r.exitCode === 0 ? r.stdout.toString().trim() || "unknown" : "unknown";
}

/** A random id made once per install; never derived from the machine or the account. */
function installId(): string {
  const id = existsSync(ID()) ? readFileSync(ID(), "utf8").trim() : "";
  if (/^[0-9a-f-]{36}$/.test(id)) return id;
  const fresh = crypto.randomUUID();
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(ID(), fresh);
  return fresh;
}

export function heartbeatBody(version: string, userId: string, now = Date.now()) {
  return {
    site: SITE,
    events: [{ name: "heartbeat", url: "/daemon", ts: Math.floor(now / 1000), user_id: userId, app_version: version, ua: `Noop/${version} (${osName()})` }],
  };
}

// Retries after 429, 5xx or a network error back off (1 min, 2, 4 ... at most 6 h); the day's stamp ends them.
let failures = 0;
let nextTry = 0;

/** Called every daemon tick; does nothing unless enabled, primary, not sent yet today (UTC) and not backing off. */
export async function usageHeartbeat(cfg: Cfg, day = new Date().toISOString().slice(0, 10), now = Date.now()): Promise<boolean> {
  if (!telemetryEnabled(cfg) || !isPrimary(cfg) || now < nextTry) return false;
  if (existsSync(STAMP()) && readFileSync(STAMP(), "utf8").trim() === day) return false;
  const version = await build();
  const status = await fetch(TELEMETRY_URL, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(heartbeatBody(version, installId(), now)),
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.status, () => 0);
  // 204 stored; 400/404 will not get better by retrying (404: the site key is wrong): either way, done for today.
  if (status === 204 || status === 400 || status === 404) {
    failures = 0;
    nextTry = 0;
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(STAMP(), day);
    return true;
  }
  nextTry = now + Math.min(60_000 * 2 ** failures++, 6 * 3600_000);
  return false;
}
