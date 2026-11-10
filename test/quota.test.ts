import { expect, test } from "bun:test";
import { quotaRecovery } from "../src/quota";

const now = Date.parse("2026-11-10T09:05:00Z");
test.each([
  ["resets 7:20pm (Asia/Shanghai)", "2026-11-10T11:22:00Z"],
  ["resets at 7:20PM (Asia/Shanghai)", "2026-11-10T11:22:00Z"],
  ["try again at 19:20 (Asia/Shanghai)", "2026-11-10T11:22:00Z"],
  ["resets 12am (Asia/Shanghai)", "2026-11-10T16:02:00Z"],
  ["resets 12pm (Asia/Shanghai)", "2026-11-11T04:02:00Z"],
  ["resets 3am (America/New_York)", "2026-11-11T08:02:00Z"],
  ["resets 7:20pm (UTC)", "2026-11-10T19:22:00Z"],
  ["try again in 2h 13m", "2026-11-10T11:20:00Z"],
  ["try again in 13 minutes", "2026-11-10T09:20:00Z"],
  ["resets in 1 hour", "2026-11-10T10:07:00Z"],
])("parses %s", (text, until) => {
  expect(quotaRecovery(text, now)).toEqual({ until: new Date(until).toISOString(), source: "parsed" });
});

test.each(["quota exhausted", "resets 25:70", "resets 125:00", "resets 7:200pm", "resets 0pm", "resets 19pm", "resets 7pm (Unknown/Zone)", "try again in a while"])
("bounded fallback: %s", text => {
  expect(quotaRecovery(text, now)).toEqual({ until: "2026-11-10T10:05:00.000Z", source: "fallback" });
});

test("grace period doesn't turn a just-passed reset into tomorrow", () => {
  expect(quotaRecovery("resets 7:20pm (Asia/Shanghai)", Date.parse("2026-11-10T11:21:00Z")).until)
    .toBe("2026-11-10T11:22:00.000Z");
});

test("uses the next local day across year boundaries", () => {
  expect(quotaRecovery("resets 1am (Asia/Tokyo)", Date.parse("2026-12-31T17:00:00Z")).until)
    .toBe("2027-01-01T16:02:00.000Z");
});

test("DST fall-back uses the future repeated hour", () => {
  expect(quotaRecovery("resets 1:30am (America/New_York)", Date.parse("2026-11-01T05:50:00Z")).until)
    .toBe("2026-11-01T06:32:00.000Z");
});

test("unspecified timezone uses the host timezone", () => {
  const local = new Date(now); local.setHours(local.getHours() + 1, 0, 0, 0);
  expect(quotaRecovery(`resets at ${local.getHours()}:00`, now).until).toBe(new Date(local.getTime() + 120_000).toISOString());
});

test.each([
  ["try again in 3 days 2 hours 37 minutes", "2026-11-13T11:44:00Z"],
  ["try again in 3d 2h 37m", "2026-11-13T11:44:00Z"],
  ["resets in 1 day", "2026-11-11T09:07:00Z"],
  ["try again in 2h13m", "2026-11-10T11:20:00Z"],
  ["try again in 0h30m", "2026-11-10T09:37:00Z"],
  ["try again in 3 days 2h37m", "2026-11-13T11:44:00Z"],
  ["try again in 2 hrs, 5 mins", "2026-11-10T11:12:00Z"],
  ["Weekly limit reached ∙ resets Nov 12, 3pm (Asia/Shanghai)", "2026-11-12T07:02:00Z"],
  ["try again at Nov 12th, 2026 3:15 PM (UTC)", "2026-11-12T15:17:00Z"],
  ["resets on November 11 at 9:00 (America/New_York)", "2026-11-11T14:02:00Z"],
  ["Claude AI usage limit reached|1762790400", "2025-11-10T16:02:00Z"],
])("parses multi-day and dated resets: %s", (text, until) => {
  const at = text.includes("|") ? Date.parse("2025-11-10T09:05:00Z") : now;
  expect(quotaRecovery(text, at)).toEqual({ until: new Date(until).toISOString(), source: "parsed" });
});

test.each(["try again in 30 days", "try again in 2hx", "resets Nov 31, 3pm (UTC)", "resets Nov 9, 3pm (UTC)", "try again at Nov 9th, 2025 3:15 PM (UTC)",
  "resets Foo 12, 3pm", "Claude AI usage limit reached|1700000000"])
("bounded fallback for distant, past or invalid dates: %s", text => {
  expect(quotaRecovery(text, now)).toEqual({ until: "2026-11-10T10:05:00.000Z", source: "fallback" });
});

test("dated reset without a year rolls into the next year", () => {
  expect(quotaRecovery("resets Jan 2, 9am (UTC)", Date.parse("2026-12-30T12:00:00Z")).until).toBe("2027-01-02T09:02:00.000Z");
});
