// A task's self-grade: the rubric's scoring, the PR / MR block, the task views and the runner's result block.
import { expect, test } from "bun:test";
import { attention, CHART_WIDTH, GRADE_SPEC, gradeMarker, gradeMarkdown, gradeMeta, gradeOf, isProductPath, lastGradeMarker, letters, measureSize, parseGrades, reviewLinks, tier, withoutGradeBlock, withMeasuredSize } from "../app/grading";
import { gitlabMr, measuredGrade, reviewedGrades, reviewFiles, runReviews, stampReview, stampReviews } from "../src/review-grade";
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

test("the PR comment is a short Chinese title line and the app card's radar and graded bars, per GitHub theme", () => {
  const g = parseGrades(result)!;
  const md = gradeMarkdown(g, { head: "f0edbe11e6434c", signature: "sig" });
  const lines = md.split("\n");
  expect(lines[0]).toBe("<!-- noop-grade:self DCBCD right f0edbe1 -->");
  expect(lines[1]).toBe("**Noop 自评** · **恰当** · 关注分 36 C · `f0edbe1`");
  expect(lines).toHaveLength(6);
  expect(lines.at(-1)).toBe("sig");
  expect(md).not.toContain("changes how one page sorts");
  expect(lines[3]).toStartWith("<table><tr><td><picture>");
  expect(lines[3]).toContain('alt="偏题 D，体量 C，风险 B，验证缺口 C，自主决定 D"');
  expect(CHART_WIDTH * 2).toBeLessThanOrEqual(500);
  const urls = [...lines[3].matchAll(/(?:srcset|src)="([^"]+)"/g)].map((m) => m[1]);
  expect(urls).toHaveLength(6);
  const charts = urls.map((u) => ({ u, c: JSON.parse(decodeURIComponent(u.split("&c=")[1])) }));
  for (const { u } of charts) expect(u).toContain("bkg=transparent");
  const [radar, bars] = [charts.filter(({ c }) => c.type === "radar"), charts.filter(({ c }) => c.type === "horizontalBar")];
  expect(radar.map(({ c }) => c.options.scale.pointLabels.fontColor)).toEqual(["#e6edf3", "#1f2328", "#8b949e"]);
  expect(radar[0].c.data.datasets[0].data).toEqual([1, 2, 3, 2, 1]);
  expect(bars[0].c.data.labels).toEqual(["偏题  D", "体量  C", "风险  B", "验证缺口  C", "自主决定  D"]);
  // risk B: three of five segments in blue
  const filled = bars[1].c.data.datasets.filter((d: { data: number[] }) => d.data[0] === 1).map((d: { backgroundColor: string[] }) => d.backgroundColor[2]);
  expect(filled).toEqual(["#4184e4", "#4184e4", "#4184e4", "#d0d7de", "#d0d7de"]);
  expect(gradeMarkdown(g, { kind: "review" })).toMatch(/^<!-- noop-grade:review DCBCD right - -->\n\*\*Noop 审查评分\*\* · /);
});

test("the block earlier versions put in the description comes out; the latest grade comment of a kind is found", () => {
  const old = "<!-- noop-grade -->\n**Noop 自评** · x\nlegend\n<!-- /noop-grade -->\n\nFixes #12.\n\nNoop signature\n";
  expect(withoutGradeBlock(old)).toBe("Fixes #12.\n\nNoop signature\n");
  expect(withoutGradeBlock("Fixes #12.")).toBe("Fixes #12.");
  const a = gradeMarker("self", { grades: "DDDDD" }, "aaaaaaa1"), b = gradeMarker("self", { grades: "CDDDD" }, "bbbbbbb2");
  expect(lastGradeMarker(["hi", `${a}\nx`, gradeMarker("review", { grades: "SSSSS" }), `${b}\ny`, "later"], "self")).toBe(b);
  expect(lastGradeMarker(["hi"], "self")).toBeNull();
});

test("a run's PRs and MRs come from its prs field, else from its summary", () => {
  expect(reviewLinks("PR https://github.com/o/r/pull/12, and https://gitlab.example.com/g/sub/p/-/merge_requests/7.")).toEqual([
    "https://github.com/o/r/pull/12", "https://gitlab.example.com/g/sub/p/-/merge_requests/7",
  ]);
  expect(runReviews(["https://github.com/o/r/pull/3"], "see https://github.com/o/r/pull/4")).toEqual(["https://github.com/o/r/pull/3"]);
  expect(runReviews(undefined, "see https://github.com/o/r/pull/4 and https://github.com/o/r/pull/4")).toEqual(["https://github.com/o/r/pull/4"]);
  expect(gitlabMr("https://gitlab.example.com/g/sub/p/-/merge_requests/7")).toEqual({ host: "gitlab.example.com", repo: "g/sub/p", iid: "7" });
});

test("grading a PR comments on it in the owner's language, cleans an old description block, and skips an unchanged grade", async () => {
  const calls: { cmd: string[]; input?: string; env?: Record<string, string> }[] = [];
  let comments: { body: string }[] = [{ body: "LGTM" }];
  const body = "<!-- noop-grade -->\nold\n<!-- /noop-grade -->\n\nOriginal body\n";
  const exec = async (cmd: string[], input?: string, env?: Record<string, string>) => {
    calls.push({ cmd, input, env });
    if (cmd[0] === "gh" && cmd[2] === "view") return { code: 0, out: JSON.stringify({ body, comments, headRefOid: "abcdef0123" }) };
    if (cmd[0] === "gh" && cmd[2] === "comment") comments = [...comments, { body: input! }];
    if (cmd[0] === "glab" && cmd[2] === "view") return { code: 0, out: JSON.stringify({ description: "MR 描述", sha: "1234567890" }) };
    if (cmd[0] === "glab" && cmd[1] === "api") return { code: 0, out: "[]" };
    return { code: 0, out: "" };
  };
  const g = { grades: "DCBCD" };
  expect(await stampReviews(["https://github.com/o/r/pull/12", "https://gitlab.example.com/g/p/-/merge_requests/7"], g, exec, { signature: "sig" }))
    .toEqual(["https://github.com/o/r/pull/12", "https://gitlab.example.com/g/p/-/merge_requests/7"]);
  const edit = calls.find((c) => c.cmd[0] === "gh" && c.cmd[2] === "edit")!;
  expect(edit.input).toBe("Original body\n");
  const post = calls.find((c) => c.cmd[0] === "gh" && c.cmd[2] === "comment")!;
  expect(post.cmd).toEqual(["gh", "pr", "comment", "https://github.com/o/r/pull/12", "--body-file", "-"]);
  expect(post.input!.startsWith("<!-- noop-grade:self DCBCD - abcdef0 -->\n**Noop 自评** · 关注分 36 C · `abcdef0`")).toBe(true);
  expect(post.input!.endsWith("\n\nsig")).toBe(true);
  const note = calls.find((c) => c.cmd[0] === "glab" && c.cmd[2] === "note")!;
  expect(note.cmd.slice(0, 5)).toEqual(["glab", "mr", "note", "7", "-R"]);
  expect(note.env).toEqual({ GITLAB_HOST: "gitlab.example.com" });
  // every project gets the same comment, in the owner's language
  expect(note.cmd.at(-1)).toContain("**Noop 自评**");
  // the same grade on the same commit again: nothing new is posted
  calls.length = 0;
  expect(await stampReview("https://github.com/o/r/pull/12", g, exec)).toBe(true);
  expect(calls.filter((c) => c.cmd[2] === "comment")).toHaveLength(0);
  // a regrade adds a comment below the earlier one
  expect(await stampReview("https://github.com/o/r/pull/12", { grades: "CCBCD" }, exec)).toBe(true);
  expect(comments).toHaveLength(3);
  // a PR the CLI cannot read is left alone
  expect(await stampReview("https://github.com/o/r/pull/9", { grades: "DDDDD" }, async () => ({ code: 1, out: "" }))).toBe(false);
});

test("a review run's grades of the PRs it reviewed are read per PR", () => {
  expect(reviewedGrades([
    { pr: "https://github.com/o/r/pull/45", grades: result },
    { pr: "https://github.com/o/r/pull/45", grades: result },
    { pr: "not a link", grades: result },
    { pr: "https://github.com/o/r/pull/46" },
  ])).toEqual([{ url: "https://github.com/o/r/pull/45", grade: parseGrades(result)! }]);
  expect(reviewedGrades(undefined)).toEqual([]);
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
