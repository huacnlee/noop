// A finished task's self-grade: the agent grades its own work on five dimensions so the owner can see at a glance,
// without reading the diff, whether it drifted, over-built or cut corners. Shared by the daemon (prompt, PR block),
// the Worker (task views) and the app (charts). No imports: this file runs in all three.

/** The five dimensions, in chart order. Every one reads "higher means the owner should look harder". */
export const DIMS = ["drift", "size", "risk", "proof", "calls"] as const;
export type Dim = (typeof DIMS)[number];

/** A grade per dimension; "?" when the agent had no evidence for it. */
export type Letter = "S" | "A" | "B" | "C" | "D" | "?";
/** How the work compares with the smallest change that meets the request. */
export type Fit = "over" | "right" | "under";

export type Grade = {
  /** Five letters in `DIMS` order, e.g. "DCBCB". */
  grades: string;
  fit?: Fit;
  /** One sentence of evidence per dimension, in `DIMS` order, then the fit's. */
  notes?: string[];
};

const POINTS: Record<Letter, number> = { S: 5, A: 4, B: 3, C: 2, D: 1, "?": 0 };
const LETTERS = Object.keys(POINTS) as Letter[];

/** The grades as letters, always five; anything unreadable counts as "?". */
export function letters(grades: string | undefined): Letter[] {
  const out = [...String(grades ?? "").toUpperCase()].slice(0, DIMS.length).map((c) => (LETTERS.includes(c as Letter) ? (c as Letter) : "?"));
  while (out.length < DIMS.length) out.push("?");
  return out;
}

/** Each grade's points, 1–5 (0 for "?"): what the radar plots. */
export const points = (grades: string | undefined): number[] => letters(grades).map((l) => POINTS[l]);

/** 关注分 / attention score: the five grades' sum × 4 (20–100). How much of the owner's review the task needs; null while any grade is "?". */
export function attention(grades: string | undefined): number | null {
  const l = letters(grades);
  return l.includes("?") ? null : l.reduce((sum, x) => sum + POINTS[x], 0) * 4;
}

/** A score's tier, as the grading skill's: S ≥80, A 64–79, B 48–63, C 32–47, D <32. */
export function tier(score: number | null): Exclude<Letter, "?"> | null {
  if (score === null) return null;
  return score >= 80 ? "S" : score >= 64 ? "A" : score >= 48 ? "B" : score >= 32 ? "C" : "D";
}

const FITS: Fit[] = ["over", "right", "under"];
const asFit = (v: unknown): Fit | undefined => {
  const s = String(v ?? "").trim().toLowerCase();
  return FITS.find((f) => s === f || s.startsWith(`${f}:`) || s.startsWith(`${f} `));
};

/** "B: why" or {grade: "B", why} → [letter, why]. */
function entry(v: unknown): [Letter, string] {
  if (v && typeof v === "object") {
    const o = v as { grade?: unknown; why?: unknown; reason?: unknown };
    return [letters(String(o.grade ?? ""))[0], String(o.why ?? o.reason ?? "").trim()];
  }
  const s = String(v ?? "").trim();
  const m = s.match(/^([SABCD?])\b\s*[:：\-—–]?\s*([\s\S]*)$/i);
  return m ? [m[1].toUpperCase() as Letter, m[2].trim()] : ["?", s];
}

/** The result block's `grades` object → a Grade; null when the agent graded nothing. */
export function parseGrades(raw: unknown): Grade | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!DIMS.some((d) => d in o)) return null;
  const rows = DIMS.map((d) => entry(o[d]));
  const fitRaw = o.fit;
  const fitWhy = typeof fitRaw === "string" ? fitRaw.replace(/^\s*\w+\s*[:：\-—–]?\s*/, "").trim()
    : fitRaw && typeof fitRaw === "object" ? String((fitRaw as { why?: unknown }).why ?? "").trim() : "";
  const fit = asFit(fitRaw && typeof fitRaw === "object" ? (fitRaw as { fit?: unknown; value?: unknown }).fit ?? (fitRaw as { value?: unknown }).value : fitRaw);
  return {
    grades: rows.map(([l]) => l).join(""),
    fit,
    notes: [...rows.map(([, why]) => why.replace(/\s+/g, " ").slice(0, 300)), fitWhy.replace(/\s+/g, " ").slice(0, 300)],
  };
}

/** Task frontmatter (one line per key) for a grade. */
export function gradeMeta(g: Grade): Record<string, string | undefined> {
  return { grade: g.grades, grade_fit: g.fit, grade_notes: g.notes?.some(Boolean) ? JSON.stringify(g.notes) : undefined };
}

/** A task's frontmatter → its grade, if it has one. `withNotes` false keeps list views small. */
export function gradeOf(meta: Record<string, string | undefined>, withNotes = true): Grade | undefined {
  if (!meta.grade || !/^[SABCD?]{5}$/.test(meta.grade)) return undefined;
  let notes: string[] | undefined;
  if (withNotes && meta.grade_notes) {
    try { const n = JSON.parse(meta.grade_notes); if (Array.isArray(n)) notes = n.map(String); } catch {}
  }
  return { grades: meta.grade, fit: asFit(meta.grade_fit), ...(notes ? { notes } : {}) };
}

type Labels = { dims: string[]; short: string[]; fit: Record<Fit, string>; score: string; pending: string; title: string; review: string; legend: string; key: [Letter, string][] };
export function labels(zh: boolean): Labels {
  return zh
    ? { dims: ["偏题", "体量", "风险", "验证缺口", "自主决定"], short: ["偏", "量", "险", "验", "决"], fit: { over: "过度", right: "恰当", under: "偏简" },
        score: "关注分", pending: "待", title: "Noop 自评", review: "Noop 审查评分", legend: "越高越需要你看，S 最高，D 最低；关注分 = 五项之和 × 4",
        key: [["S", "必须细看"], ["A", "重点看"], ["B", "看一眼"], ["C", "基本放心"]] }
    : { dims: ["Drift", "Size", "Risk", "Proof gap", "Own calls"], short: ["Dr", "Sz", "Rk", "Pf", "Cl"], fit: { over: "Over-built", right: "Right-sized", under: "Too thin" },
        score: "Attention", pending: "?", title: "Noop self-grade", review: "Noop review grade", legend: "higher means look harder, S highest, D lowest; attention = sum of the five × 4",
        key: [["S", "look closely"], ["A", "check"], ["B", "glance"], ["C", "fine"]] };
}

/** A changed file as a PR lists it. */
export type ChangedFile = { path: string; additions: number; deletions: number };

/** Product code, as the size dimension counts it: not tests, docs, locales, fixtures, snapshots, lockfiles or generated output. */
export function isProductPath(path: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)(tests?|__tests__|specs?|e2e|docs?|fixtures?|locales?|i18n|translations|examples?|snapshots?|__snapshots__|vendor|dist|build|out)\//.test(p)) return false;
  if (/\.(test|spec)\.[a-z0-9]+$|_test\.(go|rs|py)$|\.(md|mdx|txt|rst|snap|lock|svg|png|jpe?g|gif|webp|ico|pdf)$/.test(p)) return false;
  return !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum|changelog[^/]*|license[^/]*)$/.test(p);
}

/** A module, as the size dimension counts them: a crate, package or top-level source directory. */
const moduleOf = (path: string): string => {
  const parts = path.split("/");
  return parts.length > 2 && /^(crates|packages|apps|libs|modules|services|cmd|internal)$/.test(parts[0]) ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : ".";
};

/** The size grade measured from a diff's files, by the rubric's bars: S >400 lines or ≥5 modules; A 150–400 or 3–4; B 50–149; C 11–49; D ≤10. */
export function measureSize(files: ChangedFile[]): { lines: number; modules: number; grade: Exclude<Letter, "?"> } {
  const product = files.filter((f) => isProductPath(f.path));
  const lines = product.reduce((n, f) => n + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
  const modules = new Set(product.map((f) => moduleOf(f.path))).size;
  const byLines = lines > 400 ? "S" : lines >= 150 ? "A" : lines >= 50 ? "B" : lines >= 11 ? "C" : "D";
  const byModules = modules >= 5 ? "S" : modules >= 3 ? "A" : "D";
  // lines and modules pointing at different grades: the higher one
  return { lines, modules, grade: POINTS[byModules] > POINTS[byLines] ? byModules : byLines };
}

/** The agent's grade with its size checked against the diff: a measured grade above the agent's own replaces it, and says so.
 *  A measured grade below it is kept: a new dependency or abstraction layer earns S however few lines it takes. */
export function withMeasuredSize(g: Grade, m: { lines: number; modules: number; grade: Exclude<Letter, "?"> }, zh: boolean): Grade {
  const l = letters(g.grades);
  const i = DIMS.indexOf("size");
  if (l[i] !== "?" && POINTS[m.grade] <= POINTS[l[i]]) return g;
  const self = l[i] === "?" ? (zh ? "待" : "?") : l[i];
  const said = g.notes?.[i] ? (zh ? `自述：${g.notes[i]}` : ` Agent said: ${g.notes[i]}`) : "";
  const note = zh
    ? `实测 ${m.lines} 行产品代码、${m.modules} 个模块（自评 ${self}，按实测改为 ${m.grade}）。${said}`
    : `Measured ${m.lines} product lines in ${m.modules} module${m.modules === 1 ? "" : "s"} (self-graded ${self}, raised to ${m.grade}).${said}`;
  l[i] = m.grade;
  const notes = [...(g.notes ?? Array(DIMS.length + 1).fill(""))];
  notes[i] = note.trim().slice(0, 400);
  return { ...g, grades: l.join(""), notes };
}

/** The block earlier versions put on top of a PR / MR description; stripped when the grade moves to a comment. */
const START = "<!-- noop-grade -->";
const END = "<!-- /noop-grade -->";

/** A grade's or a tier's color on a PR / MR page: an HTML color that reads on both GitHub's light and dark themes.
 *  The higher, the louder, as in the app: S red, A orange, B blue, C and D gray; "?" is red (evidence missing). */
export function webColor(l: Letter | null): string {
  return l === "S" || l === "?" ? "#e5534b" : l === "A" ? "#db6d28" : l === "B" ? "#4184e4" : "#8b949e";
}

/** Whether a PR / MR description is written in Chinese: the grade follows the language the project's PRs use. */
export const isChineseText = (text: string): boolean => /[\u4e00-\u9fff]/.test(text.replace(/<!--[\s\S]*?-->/g, ""));

/** Whose grade a comment carries: the agent's own work ("self"), or a PR Noop reviewed ("review"). */
export type GradeKind = "self" | "review";

/** The hidden first line of a grade comment: which kind, and what it said, so an unchanged grade is not posted twice. */
export const gradeMarker = (kind: GradeKind, g: Grade, head = ""): string =>
  `<!-- noop-grade:${kind} ${letters(g.grades).join("")} ${g.fit ?? "-"} ${head.slice(0, 7) || "-"} -->`;

/** The marker of the latest grade comment of `kind` among a PR's / MR's comments (oldest first), if any. */
export function lastGradeMarker(comments: string[], kind: GradeKind): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = comments[i].match(new RegExp(`<!-- noop-grade:${kind} [^>]*-->`));
    if (m) return m[0];
  }
  return null;
}

/** A radar chart of the five grades as an image URL (quickchart.io renders Chart.js to PNG): GitHub / GitLab comments
 *  cannot run scripts or keep inline SVG, and an image is the one form every client, the mobile apps included, shows. */
export function radarUrl(g: Grade, dims: string[], key: [Letter, string][] = []): string {
  const l = letters(g.grades);
  const score = attention(g.grades);
  const line = webColor(score === null ? "?" : tier(score));
  const c = {
    type: "radar",
    data: {
      labels: dims.map((d, i) => `${d} ${l[i]}`),
      datasets: [{ label: score === null ? "?" : `${score}/100`, data: l.map((x) => POINTS[x]), backgroundColor: `${line}40`, borderColor: line, pointBackgroundColor: l.map((x) => webColor(x)), pointBorderColor: l.map((x) => webColor(x)), pointRadius: 5 },
        // The color key lives in the chart's own legend: empty series, one per color, so the comment holds one image.
        ...key.map(([x, text]) => ({ label: `${x === "C" ? "C/D" : x} ${text}`, data: [], backgroundColor: webColor(x), borderColor: webColor(x) }))],
    },
    options: { legend: { position: "bottom", labels: { boxWidth: 10, fontSize: 11, padding: 8 } }, layout: { padding: 2 },
      scale: { ticks: { min: 0, max: 5, stepSize: 1, display: false }, pointLabels: { fontSize: 12 } } },
  };
  return `https://quickchart.io/chart?w=380&h=250&bkg=white&f=svg&c=${encodeURIComponent(JSON.stringify(c))}`;
}

/** A grade comment on a PR / MR: a one-line verdict, and one compact radar chart whose legend
 *  is the color key. The evidence stays in the app: a reviewer needs the scores at a glance.
 *  A comment, not the description: the merge commit stays free of it, and each later run adds its own. */
export function gradeMarkdown(g: Grade, zh: boolean, opts: { kind?: GradeKind; head?: string; signature?: string } = {}): string {
  const t = labels(zh);
  const kind = opts.kind ?? "self";
  const l = letters(g.grades);
  const score = attention(g.grades);
  const title = kind === "review" ? t.review : t.title;
  const head = [
    `**${title}**${opts.head ? ` \`${opts.head.slice(0, 7)}\`` : ""}`,
    score === null ? `${t.score} —` : `${t.score} **${score}/100 ${tier(score)}**`,
    ...(g.fit ? [t.fit[g.fit]] : []),
  ].join(" · ");
  return [gradeMarker(kind, g, opts.head), head, "", `![${t.dims.map((d, i) => `${d} ${l[i]}`).join(", ")}](${radarUrl(g, t.dims, t.key)})`,
    ...(opts.signature ? ["", opts.signature] : [])].join("\n");
}

/** `body` without the grade block earlier versions put on top of it; unchanged when it has none. */
export function withoutGradeBlock(body: string): string {
  const s = body.indexOf(START), e = body.indexOf(END);
  if (s < 0 || e < s) return body;
  return `${body.slice(0, s)}${body.slice(e + END.length)}`.trim() + "\n";
}

/** PR / MR links in a text: GitHub pull requests and GitLab merge requests, each once. */
export function reviewLinks(text: string): string[] {
  const re = /https?:\/\/[^\s)\]>"'`]+?\/(?:pull\/\d+|-\/merge_requests\/\d+)(?=[^\d]|$)/g;
  return [...new Set(text.match(re) ?? [])];
}

/** What the agent is told: the rubric it grades its own work by. */
export const GRADE_SPEC = `# Self-grade (MANDATORY when you changed code, docs or config, or opened / updated a PR or MR)
The owner reviews by your grade, so make it checkable: a flattering grade the diff contradicts is worse than a high one, and Noop measures size from the PR and raises an under-reported grade. Higher = the owner should look harder. Grade each dimension from S down: the first bar met is the grade. Evidence: one sentence naming the bar and its source (a number, a file, a command and its result). No evidence → "?: <what is missing>", never a guess.
| dim | S | A | B | C | D |
|---|---|---|---|---|---|
| drift from the request | did something else, or changed unrelated behaviour | unrequested features or refactors, or a requested part left out | ambiguous request read one way (state it) | small extras: a nearby cleanup, tests, docs | exactly as asked |
| size: product lines ± and modules, no tests / docs / locales / lockfiles | >400, ≥5 modules, or a new dependency or abstraction layer | 150–400, 3–4 modules, or a new public API, config key or format | 50–149 | 11–49 | ≤10 |
| risk if wrong | data shape or migration, production, security, a release, irreversible | public API or protocol, a core path, hard to roll back | one feature's behaviour, a revert undoes it | internal, covered by tests | docs, tests, comments |
| proof gap: what did NOT run | nothing | only type check / build, or tests fail or skipped | old tests pass, nothing exercises the change | new tests pass; not run for real yet | tests plus a real run: CI green, the app, a screenshot |
| calls you made for the owner | product or user-visible choice among trade-offs | sources conflicted, you picked one | unspecified, inferred from the product's conventions (state it) | the request or spec said so | obvious: crash, failing test, typo |
Tie-breaks: lines vs modules → the higher. Doing unasked things is drift; choosing how is calls. Risk is the worst plausible outcome. Proof counts only what ran in this run.
"fit" against the smallest change that fully meets the request: "over" (extra layers, options, features), "right", or "under" (requested cases, errors, platforms or tests missing), with what is extra or missing.
Format: "grades": {"drift": "C: also renamed two helpers in the file", "size": "C: 34 product lines in src/", "risk": "B: changes the task list order; revertible", "proof": "C: sort.test.ts added, 12 pass; CI running", "calls": "B: order unspecified, newest-first like the chat list", "fit": "right: one comparator and its test"}, plus "prs": ["<every PR / MR this run opened or updated>"].
Noop posts the scores as a comment on those PRs / MRs itself, in each PR's own language, and adds a new one when a later run regrades; do not write them into descriptions or comments. Omit "grades" for lookups, reviews of others' work, no-change routine runs and delegated runs.
Reviewing someone else's PR / MR: grade it by the same rubric in "reviewed" (one entry per PR / MR you reviewed this run, the author's work in place of yours: drift from its stated goal or issue, proof gap = what its tests and CI did not cover, calls = choices it leaves to the maintainer). Noop posts it as a review-grade comment; do not repeat the scores in your review text.`;
