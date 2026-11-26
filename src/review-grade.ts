// Puts a task's self-grade at the top of the PRs / MRs it opened, so a reviewer sees the scores before the diff.
// One read and one edit per PR (gh: GraphQL), only when a run returns grades: no polling, nothing on the Worker.
import { type ChangedFile, type Grade, gradeMarkdown, isChineseText, measureSize, reviewLinks, withGradeBlock, withMeasuredSize } from "../app/grading";

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

/** `body` with the grade on top, in the language the description is written in (each project's own rule, not the owner's chat language). */
export const stampedBody = (body: string, grade: Grade): string => withGradeBlock(body, gradeMarkdown(grade, isChineseText(withGradeBlock(body, ""))));

/** Rewrites one PR / MR description with the grade block on top. False when the CLI is missing or refused. */
export async function stampReview(url: string, grade: Grade, exec: Run = run): Promise<boolean> {
  const mr = gitlabMr(url);
  if (mr) {
    const env = { GITLAB_HOST: mr.host };
    const view = await exec(["glab", "mr", "view", mr.iid, "-R", mr.repo, "-F", "json"], undefined, env);
    if (view.code !== 0) return false;
    let body = "";
    try { body = String(JSON.parse(view.out).description ?? ""); } catch { return false; }
    return (await exec(["glab", "mr", "update", mr.iid, "-R", mr.repo, "--description", stampedBody(body, grade)], undefined, env)).code === 0;
  }
  const view = await exec(["gh", "pr", "view", url, "--json", "body", "-q", ".body"]);
  if (view.code !== 0) return false;
  return (await exec(["gh", "pr", "edit", url, "--body-file", "-"], stampedBody(view.out.replace(/\n$/, ""), grade))).code === 0;
}

/** The PRs / MRs a run names: its `prs`, else the links in its summary. */
export function runReviews(prs: unknown, summary: string): string[] {
  const listed = Array.isArray(prs) ? prs.map(String).flatMap(reviewLinks) : [];
  return [...new Set(listed.length ? listed : reviewLinks(summary))].slice(0, 5);
}

/** Stamps every PR / MR of a run; returns the links that were updated. */
export async function stampReviews(links: string[], grade: Grade, exec: Run = run): Promise<string[]> {
  const done: string[] = [];
  for (const url of links) if (await stampReview(url, grade, exec).catch(() => false)) done.push(url);
  return done;
}
