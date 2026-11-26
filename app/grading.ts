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

type Labels = { dims: string[]; short: string[]; fit: Record<Fit, string>; score: string; pending: string; title: string; legend: string };
export function labels(zh: boolean): Labels {
  return zh
    ? { dims: ["偏题", "体量", "风险", "验证缺口", "自主决定"], short: ["偏", "量", "险", "验", "决"], fit: { over: "过度", right: "恰当", under: "偏简" },
        score: "关注分", pending: "待", title: "Noop 自评", legend: "越高越需要你看：S 最高，D 最低；关注分 = 五项之和 × 4" }
    : { dims: ["Drift", "Size", "Risk", "Proof gap", "Own calls"], short: ["Dr", "Sz", "Rk", "Pf", "Cl"], fit: { over: "Over-built", right: "Right-sized", under: "Too thin" },
        score: "Attention", pending: "?", title: "Noop self-grade", legend: "Higher means look harder: S highest, D lowest; attention = sum of the five × 4" };
}

const START = "<!-- noop-grade -->";
const END = "<!-- /noop-grade -->";

/** The block that opens a PR / MR description: the scores first, then one line of evidence per dimension. */
export function gradeMarkdown(g: Grade, zh: boolean): string {
  const t = labels(zh);
  const l = letters(g.grades);
  const score = attention(g.grades);
  const head = `**${t.title}** · ${t.score} ${score === null ? "—" : `${score}·${tier(score)}`}${g.fit ? ` · ${zh ? "分寸" : "Fit"}: ${t.fit[g.fit]}` : ""}`;
  const table = `| ${t.dims.join(" | ")} |\n|${t.dims.map(() => ":-:").join("|")}|\n| ${l.map((x) => (x === "?" ? t.pending : x)).join(" | ")} |`;
  const why = DIMS.map((_, i) => `- ${t.dims[i]} ${l[i] === "?" ? t.pending : l[i]}${g.notes?.[i] ? `: ${g.notes[i]}` : ""}`);
  if (g.fit && g.notes?.[DIMS.length]) why.push(`- ${zh ? "分寸" : "Fit"} ${t.fit[g.fit]}: ${g.notes[DIMS.length]}`);
  return [START, head, "", table, "", `<sub>${t.legend}</sub>`, "", ...why, END].join("\n");
}

/** `body` with the grade block at its top: an earlier block is replaced, the rest kept as it was. */
export function withGradeBlock(body: string, block: string): string {
  const s = body.indexOf(START), e = body.indexOf(END);
  const rest = s >= 0 && e > s ? body.slice(0, s) + body.slice(e + END.length) : body;
  return `${block}\n\n${rest.trim()}`.trimEnd() + "\n";
}

/** PR / MR links in a text: GitHub pull requests and GitLab merge requests, each once. */
export function reviewLinks(text: string): string[] {
  const re = /https?:\/\/[^\s)\]>"'`]+?\/(?:pull\/\d+|-\/merge_requests\/\d+)(?=[^\d]|$)/g;
  return [...new Set(text.match(re) ?? [])];
}

/** What the agent is told: the rubric it grades its own work by. */
export const GRADE_SPEC = `# Self-grade (MANDATORY when you changed code, docs or config, or opened / updated a PR or MR)
The owner cannot read every diff. Grade your own work honestly so a glance shows whether you drifted, over-built or cut corners; a flattering grade that the diff contradicts is worse than a high one. Return it as "grades" in the result block. Grade each dimension from S down: the first bar the work meets is its grade. Every dimension reads "higher = the owner should look harder". Write "?" only when you truly have no evidence, and say what is missing.
| dim | S | A | B | C | D |
|---|---|---|---|---|---|
| drift: how far the result is from what was asked | did something other than asked, or changed unrelated behaviour | added unrequested features or refactors, or left out a requested part | read an ambiguous request one way; state the reading | small incidental extras (a nearby cleanup, extra tests or docs) | exactly what was asked |
| size: product lines added+deleted, excluding tests, docs, locales | >400 lines, ≥5 modules, or a new dependency / framework / abstraction layer | 150–400 lines, 3–4 modules, or a new public API, config key or file format | 50–149 lines | 11–49 lines | ≤10 lines, or no product code |
| risk: the worst outcome if it is wrong | data shape or migration, production data or config, security or permissions, a release, anything irreversible | a public API or protocol, a core path every user hits, hard to roll back | user-visible behaviour of one feature, undone by a revert | internal only and covered by tests | docs, tests or comments only |
| proof: what is NOT verified | nothing was run | only a type check or build, or tests fail or were skipped | existing tests pass, but nothing exercises the change | new or updated tests cover it and pass; not run for real yet (CI pending, no device or app run) | covered by tests and exercised for real (CI green, the app run, a screenshot, a reproduction) |
| calls: decisions you made that the owner did not | picked a product direction or user-visible behaviour among trade-offs without asking | sources conflicted (spec, docs, code, issue) and you picked one | not specified, inferred from a baseline (the product's own conventions); state the inference | the spec or issue said what to do | obvious: a crash, a failing test, a typo |
Also give "fit": how the work compares with the smallest change that fully meets the request: "over" (more machinery than the ask needs), "right", or "under" (thinner than asked: missing cases, tests, platforms or edge handling), with one sentence why.
Format: "grades": {"drift": "D: <one sentence of evidence>", "size": "C: ~40 lines in src/x.ts", "risk": "...", "proof": "...", "calls": "...", "fit": "right: <why>"}, plus "prs": ["<url of every PR / MR this run opened or updated>"].
Noop puts the scores at the top of each PR / MR in "prs" itself: do not write a grade block into PR descriptions. Omit "grades" for pure lookups, reviews of others' work, no-change routine runs and delegated runs.`;
