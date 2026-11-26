// The Worker's daily usage report to the author's NsMetry instance (site `noop`, path `/worker`).
//
// The primary redeploys this Worker on every Noop update, while the apps update only when their users do: the Worker
// reports which clients are in use even when the apps are old (and older apps send nothing themselves).
// One event a day, counts only: machines online, owner logins active in the last 24 hours by platform (from the
// login's User-Agent), and MCP connectors. Never an email, address, session, host name, task or message.
// Off with `[telemetry] enabled = false` (or NOOP_TELEMETRY=0 / DO_NOT_TRACK=1 on the deploying machine), which
// `noop cloud deploy` turns into HUB_TELEMETRY=off.
//
// Budget (cloud/src/budget.ts): one outbound fetch a day (a subrequest, not a request to this account), one indexed
// kv read per object wake, and one kv row written a day (plus the install id, once).
export const NSMETRY_URL = "https://nsmetry.huacnlee-account.workers.dev/api/events/batch";
const SITE = "noop";

export const telemetryOn = (v: string | undefined) => !/^(0|false|off|no)$/i.test(v ?? "");

export const PLATFORMS = ["ios", "android", "macos", "windows", "linux", "web", "other"] as const;
type Platform = (typeof PLATFORMS)[number];

/** A browser (any "Mozilla/" UA) counts as web; the native apps by their OS. */
export function platformOf(ua: string): Platform {
  if (/^Mozilla\//.test(ua)) return "web";
  if (/iPhone|iPad|iOS/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac ?OS|Darwin|Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

export interface Seen { machines: number; sessions: { ua: string; scope: string | null }[] }

export function workerReport(build: string, userId: string, seen: Seen, now = Date.now()) {
  const props: Record<string, number> = { machines: seen.machines, mcp: 0 };
  for (const p of PLATFORMS) props[p] = 0;
  for (const s of seen.sessions) {
    if (s.scope === "mcp" || (s.scope == null && s.ua.startsWith("mcp:"))) props.mcp! += 1;
    else props[platformOf(s.ua)]! += 1;
  }
  return {
    site: SITE,
    events: [{ name: "heartbeat", url: "/worker", ts: Math.floor(now / 1000), user_id: userId, app_version: build, ua: `Noop/${build} (Cloudflare Workers)`, props }],
  };
}

/** One report per UTC day: 204 stored, 400/404 will not get better by retrying (404: wrong site key), so both end the
 *  day; 429, 5xx and network errors back off (1 min, 2, 4 ... at most 6 h) in memory. */
export class DailyReport {
  day = "";
  failures = 0;
  nextTry = 0;
  busy = false;
  constructor(private io: {
    enabled: () => boolean;
    build: () => string;
    /** The day already reported, persisted. */
    lastDay: () => string;
    markDay: (day: string) => void;
    installId: () => string;
    seen: () => Seen;
    post: (body: unknown) => Promise<number>;
  }) {}

  /** Called on every request; returns the send to keep alive (waitUntil) when one starts. */
  tick(now = Date.now()): Promise<void> | undefined {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.day === day || this.busy || now < this.nextTry || !this.io.enabled()) return;
    if (this.io.lastDay() === day) { this.day = day; return; }
    this.busy = true;
    const body = workerReport(this.io.build(), this.io.installId(), this.io.seen(), now);
    return this.io.post(body).catch(() => 0).then((status) => {
      if (status === 204 || status === 400 || status === 404) {
        this.day = day; this.failures = 0; this.nextTry = 0;
        this.io.markDay(day);
      } else this.nextTry = now + Math.min(60_000 * 2 ** this.failures++, 6 * 3600_000);
    }).finally(() => { this.busy = false; });
  }
}
