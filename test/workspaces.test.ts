import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { workspaceNote } from "../src/runner";
import { strayWorkspaces, taskWorkspace, workspaceName } from "../src/workspaces";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

async function repoIn(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await $`git -C ${dir} init -q -b main && git -C ${dir} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`.quiet();
  writeFileSync(join(dir, "README.md"), "x");
  await $`git -C ${dir} add README.md && git -C ${dir} -c user.email=t@t -c user.name=t commit -q -m readme`.quiet();
  return dir;
}

test("a repo task runs in its own worktree under the workspace root, never in the owner's checkout", async () => {
  const home = tmp("noop-ws-");
  const repo = await repoIn(join(home, "work", "nsh"));
  const cfg = { resources: { workspace_dir: join(home, ".noop", "work") } };
  const dir = await taskWorkspace({ id: "T-1", repo }, cfg, "/hub");
  expect(dir).toBe(join(home, ".noop", "work", "nsh-T-1"));
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("x");
  // the owner's checkout keeps its branch; the worktree is detached so the agent makes its own branch
  expect((await $`git -C ${repo} branch --show-current`.text()).trim()).toBe("main");
  expect((await $`git -C ${dir} branch --show-current`.text()).trim()).toBe("");
  // a resumed task finds the same worktree
  writeFileSync(join(dir, "wip.txt"), "keep");
  expect(await taskWorkspace({ id: "T-1", repo }, cfg, "/hub")).toBe(dir);
  expect(existsSync(join(dir, "wip.txt"))).toBe(true);
  // tasks without a repo keep the fallback (the hub)
  expect(await taskWorkspace({ id: "T-2" }, cfg, "/hub")).toBe("/hub");
});

test("when no worktree can be made the task still runs under the workspace root", async () => {
  const home = tmp("noop-ws-");
  const notRepo = join(home, "work", "plain");
  mkdirSync(notRepo, { recursive: true });
  const cfg = { resources: { workspace_dir: join(home, ".noop", "work") } };
  const dir = await taskWorkspace({ id: "T-3", repo: notRepo }, cfg, "/hub");
  expect(dir).toBe(join(home, ".noop", "work", workspaceName(notRepo, "T-3")));
  expect(existsSync(dir)).toBe(true);
});

test("strayWorkspaces lists worktrees and task folders left next to or inside the owner's repos", async () => {
  const home = tmp("noop-ws-");
  const repo = await repoIn(join(home, "work", "nsh"));
  const cfg = { resources: { work_dirs: [join(home, "work")], workspace_dir: join(home, ".noop", "work"), scratch_dirs: [] } };
  await taskWorkspace({ id: "T-9", repo }, cfg, "/hub"); // managed: not stray
  await $`git -C ${repo} worktree add -q --detach ${join(home, "work", "nsh-T-11040")}`.quiet();
  await $`git -C ${repo} worktree add -q --detach ${join(repo, ".claude", "worktrees", "agent-a1")}`.quiet();
  await $`git -C ${repo} worktree add -q --detach ${join(home, "elsewhere")}`.quiet();
  const stray = await strayWorkspaces(cfg, home);
  const kinds = Object.fromEntries(stray.map((s) => [s.path, s.kind]));
  expect(kinds).toEqual({
    [join(home, "elsewhere")]: "worktree",
    [join(home, "work", "nsh-T-11040")]: "task-dir",
    [join(repo, ".claude", "worktrees", "agent-a1")]: "claude-worktree",
  });
  // listing removes nothing
  expect(existsSync(join(home, "work", "nsh-T-11040"))).toBe(true);
});

test("the prompt points the agent at its worktree and keeps it out of the owner's checkout", () => {
  const note = workspaceNote({ id: "T-7", repo: "~/work/nsh", workspace: "/h/.noop/work/nsh-T-7" }, "/h/.noop/data");
  expect(note).toContain("/h/.noop/work/nsh-T-7");
  expect(note).toContain("never switch its branch");
  expect(note).toContain("~/.noop/work");
  expect(note).not.toContain("agent-hub");
  expect(workspaceNote({ id: "T-8" }, "/h/.noop/data").startsWith("/h/.noop/data")).toBe(true);
});
