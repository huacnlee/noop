import { expect, test } from "bun:test";
import { autoResumable, backoffMinutes, isAccountCheck, isMergeCard, isNoChangeRoutine, mergeHeadline, tooManyWakes, waitCause, waitKind, waitMeta, waitOver } from "../src/waits";

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

test("waitCause: quota waits are told apart from CI and people (T-0064 / D-0013)", () => {
  expect(waitCause({ wait_check: "bun /x/src/review-account.ts check claude", waiting_on: "恢复后合并 PR #4" })).toBe("quota");
  expect(waitCause({ waiting_on: "Claude 共享账户额度冷却至 19:22" })).toBe("quota");
  expect(waitCause({ waiting_on: "rate limit resets at 3pm" })).toBe("quota");
  expect(waitCause({ waiting_on: "CI run 123", wait_check: "gh run view 123" })).toBe("ci");
  expect(waitCause({ waiting_on: "owner 合并 PR" })).toBe("human");
  const acct = "bun /Users/k/w/noop/src/review-account.ts check claude";
  expect([waitOver(acct, 0, 0), waitOver(acct, 1, undefined), waitOver("gh run view 1", 0, 0), waitOver("gh run view 1", 0, 1), waitOver("true", 0, undefined)]).toEqual([true, false, false, true, false]);
  // an inverted or wrapped account check keeps the exit-code-change rule: 0 there means still cooling down
  expect([isAccountCheck(acct), isAccountCheck(`! ${acct}`), isAccountCheck(`${acct} || true`), isAccountCheck(`${acct} | grep ok`)]).toEqual([true, false, false, false]);
  expect(waitOver(`! ${acct}`, 0, 0)).toBe(false);
  const q = { wait_check: "bun review-account.ts check claude" };
  expect(autoResumable(q)).toBe(true);
  expect(autoResumable({ ...q, decision: "D-1" }, { open: true, supervisor_cause: "platform:os:macos" })).toBe(true);
  expect(autoResumable({ ...q, decision: "D-1" }, { open: true })).toBe(false);
  expect(autoResumable({ ...q, decision: "D-1" }, { open: false, supervisor_cause: "platform:os:macos" })).toBe(false); // supervisor resume delivers the answer
  expect(autoResumable({ wait_check: "gh run view 1" })).toBe(false);
});
