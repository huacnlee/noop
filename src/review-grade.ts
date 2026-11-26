// Posts a task's self-grade as a comment on the PRs / MRs it opened, and a reviewer's grade on the PRs it reviewed,
// so a reader sees the scores before the diff. One read and at most one comment per PR, only when a run returns grades.
import { type ChangedFile, type Grade, type GradeKind, gradeMarker, gradeMarkdown, lastGradeMarker, measureSize, parseGrades, reviewLinks, withMeasuredSize, withoutGradeBlock } from "../app/grading";

type Run = (cmd: string[], input?: string, env?: Record<string, string>) => Promise<{ code: number; out: string }>;

const run: Run = async (cmd, input, env) => {
  if (!Bun.which(cmd[0])) return { code: 127, out: "" }; // Bun.spawn throws on a missing binary
  const p = Bun.spawn(cmd, { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
};

/** A GitLab MR link → what `glab` needs: its host, project path and number. */
export function gitlabMr(url: string): { host: string; repo: string; iid: string } | null {
  const m = url.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
  return m ? { host: m[1], repo: m[2], iid: m[3] } : null;
}

/** A PR's / MR's changed files with their line counts, as the host reports them; null when the CLI cannot read it. */
export async function reviewFiles(url: string, exec: Run = run): Promise<ChangedFile[] | null> {
  const mr = gitlabMr(url);
  if (mr) {
    const r = await exec(["glab", "api", `projects/${encodeURIComponent(mr.repo)}/merge_requests/${mr.iid}/diffs?per_page=100`], undefined, { GITLAB_HOST: mr.host });
    if (r.code !== 0) return null;
    try {
      return (JSON.parse(r.out) as { new_path: string; diff?: string }[]).map((f) => {
        const lines = (f.diff ?? "").split("\n").filter((l) => !/^(\+\+\+|---) /.test(l));
        return { path: f.new_path, additions: lines.filter((l) => l.startsWith("+")).length, deletions: lines.filter((l) => l.startsWith("-")).length };
      });
    } catch { return null; }
  }
  const r = await exec(["gh", "pr", "view", url, "--json", "files", "-q", ".files"]);
  if (r.code !== 0) return null;
  try { return (JSON.parse(r.out) as ChangedFile[]).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })); } catch { return null; }
}

/** The grade with its size checked against the run's PRs / MRs: the agent's own size grade can be raised, never lowered. */
export async function measuredGrade(grade: Grade, links: string[], zh: boolean, exec: Run = run): Promise<Grade> {
  const files: ChangedFile[] = [];
  for (const url of links) {
    const f = await reviewFiles(url, exec).catch(() => null);
    if (f) files.push(...f);
  }
  return files.length ? withMeasuredSize(grade, measureSize(files), zh) : grade;
}

/** What a grade comment needs from a PR / MR: its description, its comments (oldest first) and its head commit. */
type Thread = { body: string; comments: string[]; head: string };

async function readThread(url: string, exec: Run): Promise<Thread | null> {
  const mr = gitlabMr(url);
  if (mr) {
    const env = { GITLAB_HOST: mr.host };
    const view = await exec(["glab", "mr", "view", mr.iid, "-R", mr.repo, "-F", "json"], undefined, env);
    if (view.code !== 0) return null;
    const notes = await exec(["glab", "api", `projects/${encodeURIComponent(mr.repo)}/merge_requests/${mr.iid}/notes?sort=asc&per_page=100`], undefined, env);
    try {
      const v = JSON.parse(view.out);
      const n = notes.code === 0 ? (JSON.parse(notes.out) as { body?: string }[]).map((x) => String(x.body ?? "")) : [];
      return { body: String(v.description ?? ""), comments: n, head: String(v.sha ?? "") };
    } catch { return null; }
  }
  const view = await exec(["gh", "pr", "view", url, "--json", "body,comments,headRefOid"]);
  if (view.code !== 0) return null;
  try {
    const v = JSON.parse(view.out) as { body?: string; comments?: { body?: string }[]; headRefOid?: string };
    return { body: String(v.body ?? ""), comments: (v.comments ?? []).map((c) => String(c.body ?? "")), head: String(v.headRefOid ?? "") };
  } catch { return null; }
}

/** Posts the grade as a comment on one PR / MR, in the language its description is written in (each project's own rule,
 *  not the owner's chat language). A later run with a new grade or a new head commit adds another comment; the same
 *  grade on the same commit is not posted twice. A grade block an earlier version put in the description is removed.
 *  False when the CLI is missing or refused. */
export async function stampReview(url: string, grade: Grade, exec: Run = run, opts: { kind?: GradeKind; signature?: string } = {}): Promise<boolean> {
  const kind = opts.kind ?? "self";
  const t = await readThread(url, exec);
  if (!t) return false;
  const mr = gitlabMr(url);
  const env = mr ? { GITLAB_HOST: mr.host } : undefined;
  const clean = withoutGradeBlock(t.body);
  if (clean !== t.body) {
    const edit = mr ? await exec(["glab", "mr", "update", mr.iid, "-R", mr.repo, "--description", clean], undefined, env)
      : await exec(["gh", "pr", "edit", url, "--body-file", "-"], clean);
    if (edit.code !== 0) return false;
  }
  if (lastGradeMarker(t.comments, kind) === gradeMarker(kind, grade, t.head)) return true;
  const text = gradeMarkdown(grade, { kind, head: t.head, signature: opts.signature });
  const post = mr ? await exec(["glab", "mr", "note", mr.iid, "-R", mr.repo, "-m", text], undefined, env)
    : await exec(["gh", "pr", "comment", url, "--body-file", "-"], text);
  return post.code === 0;
}

/** The PRs / MRs a run names: its `prs`, else the links in its summary. */
export function runReviews(prs: unknown, summary: string): string[] {
  const listed = Array.isArray(prs) ? prs.map(String).flatMap(reviewLinks) : [];
  return [...new Set(listed.length ? listed : reviewLinks(summary))].slice(0, 5);
}

/** Stamps every PR / MR of a run; returns the links that were updated. */
export async function stampReviews(links: string[], grade: Grade, exec: Run = run, opts: { kind?: GradeKind; signature?: string } = {}): Promise<string[]> {
  const done: string[] = [];
  for (const url of links) if (await stampReview(url, grade, exec, opts).catch(() => false)) done.push(url);
  return done;
}

/** A review run's `reviewed` field → each reviewed PR / MR with its grade; entries without a link or a grade are dropped. */
export function reviewedGrades(raw: unknown): { url: string; grade: Grade }[] {
  if (!Array.isArray(raw)) return [];
  const out: { url: string; grade: Grade }[] = [];
  for (const r of raw.slice(0, 30)) {
    const o = (r ?? {}) as { pr?: unknown; grades?: unknown };
    const url = reviewLinks(String(o.pr ?? ""))[0];
    const grade = parseGrades(o.grades);
    if (url && grade && !out.some((x) => x.url === url)) out.push({ url, grade });
  }
  return out;
}
