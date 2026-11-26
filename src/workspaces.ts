// ------------------------------------------------------------------ per-task workspaces
// A task with a repo used to run inside the owner's own checkout (e.g. ~/work/nsh). Agents then switched its branch,
// left package.json/node_modules in it, and made worktrees next to it (~/work/nsh-T-11040) or inside it
// (.claude/worktrees). Now every task gets its own git worktree under one Noop folder, ~/.noop/work, so the owner's
// checkouts stay untouched and all of Noop's working copies can be deleted in one go.

import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { $ } from "bun";
import type { Cfg } from "./core";

const expand = (p: string, home = homedir()) => resolve(p.replace(/^~(?=$|\/)/, home));
// path.sep, not "/": on Windows resolved paths use backslashes
const within = (p: string, root: string) => p === root || p.startsWith(root + sep);

/** The one folder that holds every Noop working copy: `[resources].workspace_dir`, default ~/.noop/work. */
export const workspaceRoot = (cfg: Cfg, home = homedir()): string =>
  expand(cfg.resources?.workspace_dir ?? "~/.noop/work", home);

/** Folder name of a task's worktree: "<repo>-<task id>", e.g. nsh-T-11390. */
export const workspaceName = (repo: string, id: string): string => `${basename(expand(repo))}-${id}`;

/** The directory a task runs in. A repo task gets a git worktree of that repo under the workspace root, detached at the
 *  remote's default branch (or the checkout's HEAD when there is no remote), so the agent starts clean and makes its
 *  own branch. A task that resumes finds the worktree it already had. When no worktree can be made, the task still runs
 *  under the workspace root, never in the owner's checkout. Tasks without a repo keep `fallback` (the hub). */
export async function taskWorkspace(meta: { id: string; repo?: string } | Record<string, string>, cfg: Cfg, fallback: string,
  log: (line: string) => void = () => {}): Promise<string> {
  if (!meta.repo) return fallback;
  const repo = expand(meta.repo);
  const root = workspaceRoot(cfg);
  if (within(repo, root)) return repo; // already a Noop workspace
  const dir = join(root, workspaceName(repo, meta.id));
  if (existsSync(dir)) return dir;
  mkdirSync(root, { recursive: true });
  if (existsSync(join(repo, ".git"))) {
    await $`git -C ${repo} fetch --quiet origin`.quiet().nothrow();
    const head = await $`git -C ${repo} rev-parse --verify --quiet origin/HEAD`.quiet().nothrow();
    const base = head.exitCode === 0 ? "origin/HEAD" : "HEAD";
    const add = await $`git -C ${repo} worktree add --detach ${dir} ${base}`.quiet().nothrow();
    if (add.exitCode === 0) return dir;
    log(`worktree add failed for ${repo}: ${add.stderr.toString().trim().split("\n").pop()}`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type Stray = { path: string; kind: "worktree" | "claude-worktree" | "task-dir"; repo?: string };

/** Working copies Noop left outside the workspace root: linked worktrees of the owner's repos that live elsewhere,
 *  Claude Code's `.claude/worktrees` inside a repo, and task-named folders next to the repos (e.g. ~/work/nsh-T-11040).
 *  Read-only: it lists them for the owner to confirm; nothing is removed. */
export async function strayWorkspaces(cfg: Cfg, home = homedir()): Promise<Stray[]> {
  const keep = [workspaceRoot(cfg, home), ...(cfg.resources?.scratch_dirs ?? ["~/.agent-hub/work"]).map((d: string) => expand(d, home))];
  const managed = (p: string) => keep.some((k) => within(p, k));
  const roots: string[] = (cfg.resources?.work_dirs ?? ["~/work"]).map((d: string) => expand(d, home)).filter(existsSync);
  const out = new Map<string, Stray>();
  const dirs = roots.flatMap((root) => readdirSync(root).map((name) => ({ name, dir: join(root, name) })))
    .filter(({ dir }) => existsSync(join(dir, ".git")));
  // task-named linked worktrees next to the repos first, so the repo pass below does not relabel them
  for (const { name, dir } of dirs)
    if (!lstatSync(join(dir, ".git")).isDirectory() && /(^|[-_])t-?[a-z]?\d{3,}|agent/i.test(name)) out.set(dir, { path: dir, kind: "task-dir" });
  for (const { dir } of dirs) {
    if (!lstatSync(join(dir, ".git")).isDirectory()) continue;
    const list = await $`git -C ${dir} worktree list --porcelain`.quiet().nothrow();
    const paths = list.stdout.toString().split("\n").filter((l) => l.startsWith("worktree ")).map((l) => resolve(l.slice(9).trim())); // git prints C:/... on Windows
    for (const p of paths.slice(1)) if (!managed(p) && !out.has(p) && existsSync(p))
      out.set(p, { path: p, kind: p.includes(join(sep, ".claude", "worktrees", sep)) ? "claude-worktree" : "worktree", repo: dir });
    const cw = join(dir, ".claude", "worktrees");
    if (existsSync(cw)) for (const w of readdirSync(cw)) {
      const p = join(cw, w);
      if (!out.has(p)) out.set(p, { path: p, kind: "claude-worktree", repo: dir });
    }
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
