// A task's self-grade: the rubric's scoring, the PR / MR block, the task views and the runner's result block.
import { expect, test } from "bun:test";
import { attention, GRADE_SPEC, gradeMarkdown, isChineseText, gradeMeta, gradeOf, isProductPath, letters, measureSize, parseGrades, reviewLinks, tier, withGradeBlock, withMeasuredSize } from "../app/grading";
import { gitlabMr, measuredGrade, reviewFiles, runReviews, stampedBody, stampReview, stampReviews } from "../src/review-grade";
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

test("the PR block is one colored line of scores and a legend, and replaces an earlier block", () => {
  const g = parseGrades(result)!;
  const en = gradeMarkdown(g, false);
  const m = (color: string, text: string) => `$\\color{${color}}\\blacksquare$ ${text}`;
  expect(en.split("\n")).toHaveLength(4);
  expect(en.split("\n")[1]).toBe(
    `**Noop self-grade** · ${m("#8b949e", "Attention **36 C**")} · Right-sized · ${m("#8b949e", "Drift **D**")} · ${m("#8b949e", "Size **C**")} · ${m("#4184e4", "Risk **B**")} · ${m("#8b949e", "Proof gap **C**")} · ${m("#8b949e", "Own calls **D**")}`,
  );
  expect(en.split("\n")[2]).toBe(`${m("#e5534b", "S")} ${m("#db6d28", "A")} ${m("#4184e4", "B")} ${m("#8b949e", "C D")}: higher means look harder, S highest, D lowest; attention = sum of the five × 4`);
  // the evidence stays in the app: none of it reaches the PR
  expect(en).not.toContain("changes how one page sorts");
  expect(gradeMarkdown({ grades: "SA?CD" }, false)).toContain(m("#e5534b", "Risk **?**"));
  const zh = gradeMarkdown(g, true);
  expect(zh.split("\n")[1].startsWith(`**Noop 自评** · ${m("#8b949e", "关注分 **36 C**")} · 恰当 · ${m("#8b949e", "偏题 **D**")}`)).toBe(true);
  const body = "Fixes #12.\n\nNoop signature";
  const once = withGradeBlock(body, zh);
  expect(once.startsWith("<!-- noop-grade -->")).toBe(true);
  expect(once.endsWith("Fixes #12.\n\nNoop signature\n")).toBe(true);
  const again = withGradeBlock(once, gradeMarkdown({ grades: "SSSSS" }, true));
  expect(again.match(/<!-- noop-grade -->/g)!.length).toBe(1);
  expect(again).toContain("关注分 **100 S**");
  expect(again).toContain("Fixes #12.");
});

test("the block follows the language of the description, not the owner's", () => {
  const g = { grades: "DCBCD" as const };
  const zhBlock = gradeMarkdown(g, true);
  // an English PR with an earlier Chinese block becomes all English
  const en = stampedBody(`${zhBlock}\n\nFixes #3381.\n\nWith \`titleBar.style\`...`, g);
  expect(en).toContain("**Noop self-grade**");
  expect(en).not.toMatch(/[\u4e00-\u9fff]/);
  expect(stampedBody("修复 #12：按钮颜色", g)).toContain("**Noop 自评**");
  expect(stampedBody("", g)).toContain("**Noop self-grade**");
  expect(isChineseText("<!-- 注释 -->\nEnglish")).toBe(false);
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
  expect(await stampReviews(["https://github.com/o/r/pull/12", "https://gitlab.example.com/g/p/-/merge_requests/7"], g, exec))
    .toEqual(["https://github.com/o/r/pull/12", "https://gitlab.example.com/g/p/-/merge_requests/7"]);
  const edit = calls.find((c) => c.cmd[0] === "gh" && c.cmd[2] === "edit")!;
  expect(edit.cmd).toEqual(["gh", "pr", "edit", "https://github.com/o/r/pull/12", "--body-file", "-"]);
  expect(edit.input!.startsWith("<!-- noop-grade -->")).toBe(true);
  expect(edit.input).toContain("Original body");
  const mr = calls.find((c) => c.cmd[0] === "glab" && c.cmd[2] === "update")!;
  expect(mr.cmd.slice(0, 5)).toEqual(["glab", "mr", "update", "7", "-R"]);
  expect(mr.env).toEqual({ GITLAB_HOST: "gitlab.example.com" });
  expect(mr.cmd.at(-1)).toContain("MR body");
  // English descriptions get an English block, whatever language the owner chats in
  expect(edit.input).toContain("**Noop self-grade**");
  // a PR the CLI cannot read is left alone
  expect(await stampReview("https://github.com/o/r/pull/9", { grades: "DDDDD" }, async () => ({ code: 1, out: "" }))).toBe(false);
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

test("size is measured from product code only, by the rubric's bars", () => {
  expect(["src/a.ts", "app/App.tsx", "crates/x/src/lib.rs"].every(isProductPath)).toBe(true);
  expect(["test/a.test.ts", "src/a.test.ts", "docs/x.md", "README.md", "bun.lockb", "app/locales/zh.json", "x/__snapshots__/a.snap", "go.sum"].some(isProductPath)).toBe(false);
  const f = (path: string, n: number) => ({ path, additions: n, deletions: 0 });
  expect(measureSize([f("src/a.ts", 8), f("test/a.test.ts", 300)])).toEqual({ lines: 8, modules: 1, grade: "D" });
  expect(measureSize([f("src/a.ts", 30)]).grade).toBe("C");
  expect(measureSize([f("src/a.ts", 120)]).grade).toBe("B");
  expect(measureSize([f("src/a.ts", 401)]).grade).toBe("S");
  // lines and modules disagree: the higher one
  expect(measureSize([f("src/a.ts", 5), f("app/b.ts", 5), f("cloud/c.ts", 5)])).toEqual({ lines: 15, modules: 3, grade: "A" });
  expect(measureSize([f("crates/a/x.rs", 2), f("crates/b/x.rs", 2), f("crates/c/x.rs", 2), f("crates/d/x.rs", 2), f("crates/e/x.rs", 2)]).grade).toBe("S");
});

test("a measured size above the agent's own replaces it and says so; one below it is kept", () => {
  const g = parseGrades(result)!; // size C
  const up = withMeasuredSize(g, { lines: 260, modules: 2, grade: "A" }, true);
  expect(up.grades).toBe("DABCD");
  expect(up.notes![1]).toBe("实测 260 行产品代码、2 个模块（自评 C，按实测改为 A）。自述：~40 lines in src/x.ts");
  expect(up.notes![0]).toBe(g.notes![0]);
  expect(withMeasuredSize(g, { lines: 3, modules: 1, grade: "D" }, false)).toBe(g); // a new dependency can be S in few lines
  expect(withMeasuredSize({ grades: "D?BCD" }, { lines: 60, modules: 1, grade: "B" }, false).grades).toBe("DBBCD");
});

test("a PR's and an MR's files are read for the measurement", async () => {
  const exec = async (cmd: string[]) => {
    if (cmd[0] === "gh") return { code: 0, out: JSON.stringify([{ path: "src/a.ts", additions: 300, deletions: 20, extra: 1 }, { path: "test/a.test.ts", additions: 90, deletions: 0 }]) };
    if (cmd[0] === "glab") return { code: 0, out: JSON.stringify([{ new_path: "lib/x.rb", diff: "@@ -1,2 +1,3 @@\n-a\n+b\n+c\n d" }]) };
    return { code: 1, out: "" };
  };
  expect(await reviewFiles("https://github.com/o/r/pull/1", exec)).toEqual([{ path: "src/a.ts", additions: 300, deletions: 20 }, { path: "test/a.test.ts", additions: 90, deletions: 0 }]);
  expect(await reviewFiles("https://gitlab.example.com/g/p/-/merge_requests/2", exec)).toEqual([{ path: "lib/x.rb", additions: 2, deletions: 1 }]);
  const g = await measuredGrade(parseGrades(result)!, ["https://github.com/o/r/pull/1"], false, exec);
  expect(letters(g.grades)[1]).toBe("A");
  expect(g.notes![1]).toContain("Measured 320 product lines in 1 module (self-graded C, raised to A)");
  // nothing readable: the agent's grade stands
  expect(await measuredGrade(parseGrades(result)!, ["https://github.com/o/r/pull/1"], false, async () => ({ code: 1, out: "" }))).toEqual(parseGrades(result)!);
});

test("the rubric the agents get carries the bars, the tie-breaks, the fit and an example", () => {
  for (const s of ["first bar met", "Tie-breaks:", "\"fit\"", "Format:", "Noop measures size"]) expect(GRADE_SPEC).toContain(s);
});
