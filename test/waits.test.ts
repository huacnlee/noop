import { describe, expect, test } from "bun:test";
import { backoffMinutes, isMergeCard, isNoChangeRoutine, mergeHeadline, sameWaitAgain, EVENT_FALLBACK_MIN, tooManyWakes, waitKind, waitMeta } from "../src/waits";

test("CI wait_check backs off 5 → 10 → 20 → 40 minutes", () => {
  expect([0, 1, 2, 3, 4, 9].map(backoffMinutes)).toEqual([5, 10, 20, 40, 40, 40]);
});

test("human waits get no timed wake-up; CI waits do", () => {
  expect(waitKind({ waiting_on: "owner 手动 make publish" })).toBe("human");
  expect(waitKind({ waiting_on: "等你点合并 nsh #1022" })).toBe("human");
  expect(waitKind({ waiting_on: "CI run https://github.com/o/r/actions/runs/1" })).toBe("ci");
  expect(waitKind({ wait_kind: "ci", waiting_on: "owner" })).toBe("ci");
  const h = waitMeta({ wait_kind: "human", wait_minutes: 30 }, 0);
  expect(h.wake_at).toBeUndefined();
  const c = waitMeta({ waiting_on: "CI", wait_minutes: 500 }, 0);
  expect(c.wake_at).toBe(new Date(120 * 60_000).toISOString());
});

test("more than 6 wake-ups blocks the task", () => {
  expect(tooManyWakes(6)).toBe(false);
  expect(tooManyWakes(7)).toBe(true);
});

test("D: merge cards are recognised and lead with the PR link", () => {
  expect(isMergeCard({ question: "现在合并 omamail #457 吗？" })).toBe(true);
  expect(isMergeCard({ question: "Merge gpui-fast #101?" })).toBe(true);
  expect(isMergeCard({ question: "#1004 用哪种修法？" })).toBe(false);
  expect(isMergeCard({ question: "合并哪几项？", kind: "menu" })).toBe(false);
  expect(mergeHeadline("见 https://github.com/huacnlee/omamail/pull/457 head 7c0b2a0")).toBe("https://github.com/huacnlee/omamail/pull/457 需要你点合并");
});

test("routine runs without changes stay out of the owner channel", () => {
  expect(isNoChangeRoutine("routine:own-prs-ci", "本轮没有修改或推送。")).toBe(true);
  expect(isNoChangeRoutine("owner@chat", "本轮没有修改")).toBe(false);
  expect(isNoChangeRoutine("routine:pr-review", "审了 nsh #981，发了评论")).toBe(false);
});

describe("event waits (T-10749)", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  test("a wait on the next stable release is an event even when labelled ci", () => {
    expect(waitKind({ wait_kind: "ci", waiting_on: "等 NSH 下一个正式版（预计 11-25）" })).toBe("event");
    expect(waitKind({ wait_kind: "ci", waiting_on: "CI run https://github.com/o/r/actions/runs/1" })).toBe("ci");
  });
  test("event fallback is a day, or the expected date", () => {
    expect(waitMeta({ wait_kind: "event", waiting_on: "x" }, now).wake_at).toBe(new Date(now + EVENT_FALLBACK_MIN * 60_000).toISOString());
    expect(waitMeta({ wait_kind: "event", wait_until: "2026-11-25T00:00:00Z" }, now).wake_at).toBe("2026-11-25T00:00:00.000Z");
    expect(waitMeta({ wait_kind: "event", wait_until: "2027-06-01" }, now).minutes).toBe(EVENT_FALLBACK_MIN);
  });
  test("re-parking on the same thing after a wake is not news", () => {
    expect(sameWaitAgain({ resumed: "yes", waiting_on: "NSH v0.7.0" }, "NSH v0.7.0")).toBe(true);
    expect(sameWaitAgain({ resumed: "yes", waiting_on: "NSH v0.7.0" }, "CI of #12")).toBe(false);
    expect(sameWaitAgain({ waiting_on: "NSH v0.7.0" }, "NSH v0.7.0")).toBe(false);
  });
});
