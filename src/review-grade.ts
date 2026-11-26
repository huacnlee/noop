// Puts a task's self-grade at the top of the PRs / MRs it opened, so a reviewer sees the scores before the diff.
// One read and one edit per PR (gh: GraphQL), only when a run returns grades: no polling, nothing on the Worker.
import { type Grade, gradeMarkdown, reviewLinks, withGradeBlock } from "../app/grading";

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

/** Rewrites one PR / MR description with the grade block on top. False when the CLI is missing or refused. */
export async function stampReview(url: string, block: string, exec: Run = run): Promise<boolean> {
  const mr = gitlabMr(url);
  if (mr) {
    const env = { GITLAB_HOST: mr.host };
    const view = await exec(["glab", "mr", "view", mr.iid, "-R", mr.repo, "-F", "json"], undefined, env);
    if (view.code !== 0) return false;
    let body = "";
    try { body = String(JSON.parse(view.out).description ?? ""); } catch { return false; }
    return (await exec(["glab", "mr", "update", mr.iid, "-R", mr.repo, "--description", withGradeBlock(body, block)], undefined, env)).code === 0;
  }
  const view = await exec(["gh", "pr", "view", url, "--json", "body", "-q", ".body"]);
  if (view.code !== 0) return false;
  return (await exec(["gh", "pr", "edit", url, "--body-file", "-"], withGradeBlock(view.out.replace(/\n$/, ""), block))).code === 0;
}

/** The PRs / MRs a run names: its `prs`, else the links in its summary. */
export function runReviews(prs: unknown, summary: string): string[] {
  const listed = Array.isArray(prs) ? prs.map(String).flatMap(reviewLinks) : [];
  return [...new Set(listed.length ? listed : reviewLinks(summary))].slice(0, 5);
}

/** Stamps every PR / MR of a run; returns the links that were updated. */
export async function stampReviews(links: string[], grade: Grade, zh: boolean, exec: Run = run): Promise<string[]> {
  const block = gradeMarkdown(grade, zh);
  const done: string[] = [];
  for (const url of links) if (await stampReview(url, block, exec).catch(() => false)) done.push(url);
  return done;
}
