import { expect, test } from "bun:test";
import { backoffMinutes, checkedFallbackMin, isMergeCard, isNoChangeRoutine, mergeHeadline, maxWaitMin, tooManyWakes, waitKind, waitMeta } from "../src/waits";

test("CI wait_check backs off 5 → 10 → 20 → 40 minutes", () => {
  expect([0, 1, 2, 3, 4, 9].map((n) => backoffMinutes(n))).toEqual([5, 10, 20, 40, 40, 40]);
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

test("[waits] max_minutes lowers the cap; a missing or too-small value keeps the 120-minute default", () => {
  expect(maxWaitMin({})).toBe(120);
  expect(maxWaitMin({ waits: { max_minutes: 20 } })).toBe(20);
  expect(maxWaitMin({ waits: { max_minutes: 1 } })).toBe(120);
  expect(maxWaitMin({ waits: { max_minutes: "soon" } })).toBe(120);
});

test("every timed wait respects the cap, and the wake budget keeps the same 12 hours of patience", () => {
  expect([0, 1, 2, 3, 9].map((n) => backoffMinutes(n, 20))).toEqual([5, 10, 20, 20, 20]);
  expect(backoffMinutes(9)).toBe(40);
  expect(checkedFallbackMin(20)).toBe(20);
  expect(checkedFallbackMin()).toBe(120);
  expect(waitMeta({ waiting_on: "CI", wait_minutes: 500 }, 0, 20).minutes).toBe(20);
  expect(waitMeta({ waiting_on: "CI", wait_minutes: 500 }, 0).minutes).toBe(120);
  expect(tooManyWakes(36, 20)).toBe(false);
  expect(tooManyWakes(37, 20)).toBe(true);
  expect(tooManyWakes(6)).toBe(false);
  expect(tooManyWakes(7)).toBe(true);
});
