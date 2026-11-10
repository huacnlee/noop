/** CLI quota reset times. No credentials, state or network access. */
export type Recovery = { until: string; source: "parsed" | "fallback" };
const GRACE = 2 * 60_000;

export function quotaRecovery(output: string, now = Date.now()): Recovery {
  const fallback = (): Recovery => ({ until: new Date(now + 3600_000).toISOString(), source: "fallback" });
  const parsed = (time: number): Recovery => ({ until: new Date(time + GRACE).toISOString(), source: "parsed" });
  const text = output.slice(-4000).replace(/\x1b\[[0-9;]*m/g, "");
  const relative = text.match(/(?:try again|resets?)\s+in\s+(?=\d)(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\b/i);
  if (relative && (relative[1] || relative[2])) return parsed(now + ((+relative[1] || 0) * 60 + (+relative[2] || 0)) * 60_000);
  const at = text.match(/(?:resets?(?:\s+at)?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])(?:\s*\(([^)]+)\))?/i);
  if (!at) return fallback();
  let hour = +at[1];
  const minute = +(at[2] ?? 0), meridiem = at[3]?.toLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || (meridiem && hour < 1)) return fallback();
  if (meridiem) hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: at[4] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const civil = (time: number) => {
      const p = Object.fromEntries(fmt.formatToParts(time).map(p => [p.type, p.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    };
    const localNow = new Date(civil(now));
    const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
    // Include both sides of DST changes. Validate the civil time so nonexistent hours aren't guessed.
    const offsets = new Set<number>();
    for (let h = -36; h <= 60; h += 6) {
      const t = Math.floor((now + h * 3600_000) / 1000) * 1000;
      offsets.add(civil(t) - t);
    }
    for (let day = 0; day < 2; day++) {
      const wanted = midnight + day * 86400_000 + (hour * 60 + minute) * 60_000;
      const candidates = [...offsets].map(offset => wanted - offset)
        .filter(t => civil(t) === wanted && t + GRACE > now).sort((a, b) => a - b);
      if (candidates.length) return parsed(candidates[0]);
    }
  } catch { /* Unknown timezone: use bounded fallback, never silently reinterpret it locally. */ }
  return fallback();
}
