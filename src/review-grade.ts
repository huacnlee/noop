// Measures a run's self-grade against the PRs / MRs it names: the size grade comes from their changed files.
// Read-only: the grades stay inside Noop and are never written to a PR / MR.
import { type ChangedFile, type Grade, measureSize, reviewLinks, withMeasuredSize } from "../app/grading";

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

/** The PRs / MRs a run names: its `prs`, else the links in its summary. */
export function runReviews(prs: unknown, summary: string): string[] {
  const listed = Array.isArray(prs) ? prs.map(String).flatMap(reviewLinks) : [];
  return [...new Set(listed.length ? listed : reviewLinks(summary))].slice(0, 5);
}
