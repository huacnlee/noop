// A task's self-grade: the rubric's scoring, the PR / MR block, the task views and the runner's result block.
import { expect, test } from "bun:test";
import { attention, gradeMarkdown, gradeMeta, gradeOf, letters, parseGrades, reviewLinks, tier, withGradeBlock } from "../app/grading";
import { gitlabMr, runReviews, stampReview, stampReviews } from "../src/review-grade";
import { parseResult } from "../src/runner";
import { taskHistory, taskInfo } from "../cloud/src/tools";

const result = {
  drift: "D: exactly the requested fix",
  size: "C: ~40 lines in src/x.ts",
  risk: { grade: "B", why: "changes how one page sorts" },
  proof: "c — unit test added, CI pending",
  calls: "D",
  fit: "right: the smallest fix that covers both cases",
};

test("grades parse from the result block, in rubric order, with their evidence", () => {
  const g = parseGrades(result)!;
  expect(g.grades).toBe("DCBCD");
  expect(g.fit).toBe("right");
  expect(g.notes).toEqual(["exactly the requested fix", "~40 lines in src/x.ts", "changes how one page sorts", "unit test added, CI pending", "", "the smallest fix that covers both cases"]);
  expect(parseGrades(undefined)).toBeNull();
  expect(parseGrades({ summary: "x" })).toBeNull();
  // a missing or unreadable dimension is "?", never a guess
  expect(parseGrades({ drift: "D: ok", size: "huge" })!.grades).toBe("D????");
});

test("the attention score is the five grades × 4, and needs every grade", () => {
  expect(attention("SSSSS")).toBe(100);
  expect(attention("DDDDD")).toBe(20);
  expect(attention("DCBCD")).toBe(36);
  expect(attention("DCB?D")).toBeNull();
  expect([80, 79, 64, 63, 48, 47, 32, 31].map(tier)).toEqual(["S", "A", "A", "B", "B", "C", "C", "D"]);
  expect(tier(null)).toBeNull();
  expect(letters("ab")).toEqual(["A", "B", "?", "?", "?"]);
});

test("a grade survives the task file's frontmatter, and list views leave the notes out", () => {
  const meta = Object.fromEntries(Object.entries(gradeMeta(parseGrades(result)!)).map(([k, v]) => [k, String(v)]));
  expect(gradeOf(meta)).toEqual({ grades: "DCBCD", fit: "right", notes: parseGrades(result)!.notes });
  expect(gradeOf(meta, false)).toEqual({ grades: "DCBCD", fit: "right" });
  expect(gradeOf({ grade: "nope" })).toBeUndefined();
});

test("the PR block leads with the scores and replaces an earlier block", () => {
  const g = parseGrades(result)!;
  const zh = gradeMarkdown(g, true);
  expect(zh.split("\n")[1]).toBe("**Noop 自评** · 关注分 36·C · 分寸: 恰当");
  expect(zh).toContain("| D | C | B | C | D |");
  expect(zh).toContain("- 风险 B: changes how one page sorts");
  expect(gradeMarkdown(g, false)).toContain("**Noop self-grade** · Attention 36·C · Fit: Right-sized");
  const body = "Fixes #12.\n\nNoop signature";
  const once = withGradeBlock(body, zh);
  expect(once.startsWith("<!-- noop-grade -->")).toBe(true);
  expect(once.endsWith("Fixes #12.\n\nNoop signature\n")).toBe(true);
  const again = withGradeBlock(once, gradeMarkdown({ grades: "SSSSS" }, true));
  expect(again.match(/<!-- noop-grade -->/g)!.length).toBe(1);
  expect(again).toContain("关注分 100·S");
  expect(again).toContain("Fixes #12.");
});

test("a run's PRs and MRs come from its prs field, else from its summary", () => {
  expect(reviewLinks("PR https://github.com/o/r/pull/12, and https://gitlab.example.com/g/sub/p/-/merge_requests/7.")).toEqual([
    "https://github.com/o/r/pull/12", "https://gitlab.example.com/g/sub/p/-/merge_requests/7",
  ]);
  expect(runReviews(["https://github.com/o/r/pull/3"], "see https://github.com/o/r/pull/4")).toEqual(["https://github.com/o/r/pull/3"]);
  expect(runReviews(undefined, "see https://github.com/o/r/pull/4 and https://github.com/o/r/pull/4")).toEqual(["https://github.com/o/r/pull/4"]);
  expect(gitlabMr("https://gitlab.example.com/g/sub/p/-/merge_requests/7")).toEqual({ host: "gitlab.example.com", repo: "g/sub/p", iid: "7" });
});

test("stamping a PR reads its body and writes it back with the block on top", async () => {
  const calls: { cmd: string[]; input?: string; env?: Record<string, string> }[] = [];
  const exec = async (cmd: string[], input?: string, env?: Record<string, string>) => {
    calls.push({ cmd, input, env });
    if (cmd[0] === "gh" && cmd[2] === "view") return { code: 0, out: "Original body\n" };
    if (cmd[0] === "glab" && cmd[2] === "view") return { code: 0, out: JSON.stringify({ description: "MR body" }) };
    return { code: 0, out: "" };
  };
  const g = { grades: "DCBCD" };
  expect(await stampReviews(["https://github.com/o/r/pull/12", "https://gitlab.example.com/g/p/-/merge_requests/7"], g, true, exec))
    .toEqual(["https://github.com/o/r/pull/12", "https://gitlab.example.com/g/p/-/merge_requests/7"]);
  const edit = calls.find((c) => c.cmd[0] === "gh" && c.cmd[2] === "edit")!;
  expect(edit.cmd).toEqual(["gh", "pr", "edit", "https://github.com/o/r/pull/12", "--body-file", "-"]);
  expect(edit.input!.startsWith("<!-- noop-grade -->")).toBe(true);
  expect(edit.input).toContain("Original body");
  const mr = calls.find((c) => c.cmd[0] === "glab" && c.cmd[2] === "update")!;
  expect(mr.cmd.slice(0, 5)).toEqual(["glab", "mr", "update", "7", "-R"]);
  expect(mr.env).toEqual({ GITLAB_HOST: "gitlab.example.com" });
  expect(mr.cmd.at(-1)).toContain("MR body");
  // a PR the CLI cannot read is left alone
  expect(await stampReview("https://github.com/o/r/pull/9", "x", async () => ({ code: 1, out: "" }))).toBe(false);
});

test("the runner asks for the self-grade and keeps it in the result", () => {
  const r = parseResult("done\n```json\n" + JSON.stringify({ status: "done", summary: "ok", grades: result, prs: ["https://github.com/o/r/pull/1"] }) + "\n```");
  expect(parseGrades(r.grades)!.grades).toBe("DCBCD");
  expect(r.prs).toEqual(["https://github.com/o/r/pull/1"]);
});

test("task views carry the grade: lists without the notes, the task's own page with them", () => {
  const files: Record<string, string> = {
    "tasks/done/T-0001.md": `---\nid: T-0001\ntitle: fix it\nagent: lead\nfinished: 2026-11-01T00:00:00Z\ngrade: DCBCD\ngrade_fit: over\ngrade_notes: ${JSON.stringify(["a: b", "", "", "", "", "too much"])}\n---\n> fix it\n`,
    "tasks/done/T-0002.md": "---\nid: T-0002\ntitle: look it up\nagent: lead\nfinished: 2026-11-02T00:00:00Z\n---\n",
  };
  const st = {
    read: (p: string) => (files[p] ? { path: p, text: files[p], updated: "2026-01-01T00:00:00Z" } : null),
    list: (d: string) => Object.keys(files).filter((p) => p.startsWith(d)).map((p) => ({ path: p, text: files[p], updated: "2026-01-01T00:00:00Z" })),
  } as any;
  const rows = taskHistory(st).tasks;
  expect(rows.find((t) => t.id === "T-0001")!.grade).toEqual({ grades: "DCBCD", fit: "over" });
  expect(rows.find((t) => t.id === "T-0002")!.grade).toBeUndefined();
  expect(taskInfo(st, "T-0001")!.grade).toEqual({ grades: "DCBCD", fit: "over", notes: ["a: b", "", "", "", "", "too much"] });
});
