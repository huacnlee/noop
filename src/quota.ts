/** CLI quota reset times. No credentials, state or network access. */
export type Recovery = { until: string; source: "parsed" | "fallback" };
const GRACE = 2 * 60_000;
// Weekly limits are the longest real resets; anything later is a misparse and gets the bounded fallback.
const MAX_AHEAD = 8 * 86400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])(?:\s*\(([^)]+)\))?`;
const MONTH = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?(?:\s+(\d{4})\b,?)?\s+(?:at\s+)?`;

export function quotaRecovery(output: string, now = Date.now()): Recovery {
  const fallback = (): Recovery => ({ until: new Date(now + 3600_000).toISOString(), source: "fallback" });
  const parsed = (time: number): Recovery =>
    time - now > MAX_AHEAD ? fallback() : { until: new Date(time + GRACE).toISOString(), source: "parsed" };
  const text = output.slice(-4000).replace(/\x1b\[[0-9;]*m/g, "");
  // Claude CLI's machine form: "Claude AI usage limit reached|<unix seconds>".
  const epoch = text.match(/limit reached\|(\d{10})\b/i);
  if (epoch && +epoch[1] * 1000 + GRACE > now) return parsed(+epoch[1] * 1000);
  const relative = text.match(/(?:try again|resets?)\s+in\s+(?=\d)(?:(\d+)\s*d(?:ays?)?(?![a-z])[\s,]*)?(?:(\d+)\s*h(?:(?:ou)?rs?)?(?![a-z])[\s,]*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?(?![a-z]))?/i);
  if (relative && (relative[1] || relative[2] || relative[3]))
    return parsed(now + (((+relative[1] || 0) * 24 + (+relative[2] || 0)) * 60 + (+relative[3] || 0)) * 60_000);
  // "resets Nov 12, 3pm" / "try again at Nov 12th, 2026 3:15 PM" before the time-only form.
  const dated = text.match(new RegExp(String.raw`(?:resets?(?:\s+(?:at|on))?|try again (?:at|on))\s+${MONTH}${CLOCK}`, "i"));
  const at = dated ? dated.slice(4) : text.match(new RegExp(String.raw`(?:resets?(?:\s+at)?|try again at)\s+${CLOCK}`, "i"))?.slice(1);
  if (!at) return fallback();
  let hour = +at[0];
  const minute = +(at[1] ?? 0), meridiem = at[2]?.toLowerCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23) || (meridiem && hour < 1)) return fallback();
  if (meridiem) hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: at[3] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const civil = (time: number) => {
      const p = Object.fromEntries(fmt.formatToParts(time).map(p => [p.type, p.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    };
    // Every offset the zone uses across the reachable window, so both sides of DST changes are tried.
    const offsets = new Set<number>();
    for (let h = -36; h <= MAX_AHEAD / 3600_000 + 36; h += 6) {
      const t = Math.floor((now + h * 3600_000) / 1000) * 1000;
      offsets.add(civil(t) - t);
    }
    // Earliest future instant showing this civil time; nonexistent (DST gap) times are never guessed.
    const instant = (wanted: number) => [...offsets].map(offset => wanted - offset)
      .filter(t => civil(t) === wanted && t + GRACE > now).sort((a, b) => a - b)[0];
    const localNow = new Date(civil(now));
    const clock = (hour * 60 + minute) * 60_000;
    if (dated) {
      const month = MONTHS.indexOf(dated[1].toLowerCase()), day = +dated[2];
      const years = dated[3] ? [+dated[3]] : [localNow.getUTCFullYear(), localNow.getUTCFullYear() + 1];
      for (const year of years) {
        const wanted = Date.UTC(year, month, day) + clock;
        if (new Date(wanted).getUTCDate() !== day) return fallback(); // Nov 31 and similar
        const t = instant(wanted);
        if (t !== undefined) return parsed(t);
      }
      return fallback();
    }
    const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
    for (let day = 0; day < 2; day++) {
      const t = instant(midnight + day * 86400_000 + clock);
      if (t !== undefined) return parsed(t);
    }
  } catch { /* Unknown timezone: use bounded fallback, never silently reinterpret it locally. */ }
  return fallback();
}
