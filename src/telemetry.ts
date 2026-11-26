import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { type Cfg, CODE, HOME_DIR, isPrimary } from "./core";

/**
 * Anonymous daily heartbeat so the Noop author can count active installs.
 *
 * Sent once a day, only by the primary machine, to the author's Edgemetry instance. The request carries the event name,
 * the Noop build date and the OS family; Edgemetry turns the IP + user agent into a daily hash and keeps no IP.
 * No email, hub URL, machine name, repository or task content is ever sent.
 * Off with `[telemetry] enabled = false` in config.toml, `NOOP_TELEMETRY=0` or `DO_NOT_TRACK=1`.
 */
export const TELEMETRY_URL = "https://metry.huacnlee-account.workers.dev/api/event";
// Same Edgemetry site as the website; the /daemon/ path keeps heartbeats apart from page views in the dashboard.
const SITE = "noop.madomd.com";
const STAMP = () => join(HOME_DIR, "telemetry-last"); // machine-local, outside the synced data folder

export function telemetryEnabled(cfg: Cfg, env = process.env): boolean {
  if (env.DO_NOT_TRACK === "1" || /^(0|false|off|no)$/i.test(env.NOOP_TELEMETRY ?? "")) return false;
  return cfg.telemetry?.enabled !== false;
}

const osName = () => ({ darwin: "Macintosh; Mac OS X", win32: "Windows NT 10.0", linux: "X11; Linux" } as Record<string, string>)[process.platform] ?? "Other";

/** The build date of the running Noop (commit date of the install), e.g. 2026-11-26; "unknown" without git. */
async function build(): Promise<string> {
  const r = await $`git log -1 --format=%cs`.cwd(CODE).quiet().nothrow();
  return r.exitCode === 0 ? r.stdout.toString().trim() || "unknown" : "unknown";
}

export function heartbeatBody(version: string) {
  return { n: "heartbeat", d: SITE, u: `https://${SITE}/daemon/v/${encodeURIComponent(version)}`, r: "", w: 0 };
}

/** Called every daemon tick; does nothing unless enabled, primary, and not sent yet today (UTC). */
export async function usageHeartbeat(cfg: Cfg, day = new Date().toISOString().slice(0, 10)): Promise<boolean> {
  if (!telemetryEnabled(cfg) || !isPrimary(cfg)) return false;
  if (existsSync(STAMP()) && readFileSync(STAMP(), "utf8").trim() === day) return false;
  mkdirSync(dirname(STAMP()), { recursive: true });
  writeFileSync(STAMP(), day); // one try a day, even if the request fails: never retry in a loop
  const version = await build();
  await fetch(TELEMETRY_URL, {
    method: "POST",
    headers: { "content-type": "text/plain", "user-agent": `Mozilla/5.0 (${osName()}) Noop/${version}` },
    body: JSON.stringify(heartbeatBody(version)),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  return true;
}
