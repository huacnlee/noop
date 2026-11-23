// Fleet metrics: `blocked/` holds tasks parked on the owner's decision, not agent failures.
// Counting them as failures understates success and corrupts the numbers the architect uses to graduate an agent.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const core = await import("../src/core");
const M = await import("../src/metrics");
const { P, writeDoc } = core;
if (!core.DATA.startsWith(tmpdir())) throw new Error(`refusing to run: DATA=${core.DATA} is not a temp dir`);

afterAll(() => rmSync(core.DATA, { recursive: true, force: true }));
beforeEach(() => { rmSync(core.DATA, { recursive: true, force: true }); mkdirSync(P("journal"), { recursive: true }); });

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const task = (folder: string, id: string, agent: string, extra: Record<string, string> = {}) =>
  writeDoc(P("tasks", folder, `${id}.md`), { id, title: `t ${id}`, agent, created: at(60), finished: at(10), started: at(50), ...extra }, "body");

test("a task parked on the owner's decision is not counted as a failure", () => {
  task("done", "T-0001", "lead");
  task("failed", "T-0002", "lead");
  task("blocked", "T-0003", "lead", { status: "needs_decision", decision: "D-0001" });
  const m = M.computeMetrics(7);
  // 1 done, 1 real failure, 1 parked → success is 1/2, and the parked one is reported apart
  expect(m.agents.lead.runs).toBe(3);
  expect(m.agents.lead.success).toBe(0.5);
  expect(m.agents.lead.failed).toBe(1);
  expect(m.agents.lead.blocked).toBe(1);
});

test("an agent that only ever asked for a decision has no success rate to judge", () => {
  task("blocked", "T-0001", "chief-of-staff", { status: "needs_decision", decision: "D-0001" });
  task("blocked", "T-0002", "chief-of-staff", { status: "needs_decision", decision: "D-0002" });
  const m = M.computeMetrics(7);
  // never a silent 0.00 — a menu that ends in a question is doing its job
  expect(m.agents["chief-of-staff"].blocked).toBe(2);
  expect(m.agents["chief-of-staff"].success).toBeNull();
});

test("a shorter task window preserves the roster's lifetime shadow scores", () => {
  const older = at(10 * 24 * 60);
  writeDoc(P("agents", "reviewer", "profile.md"), {}, "# Reviewer");
  writeDoc(P("agents", "lead", "profile.md"), {}, "# Lead");
  task("done", "T-0001", "reviewer", { created: older, started: older, finished: older });
  task("done", "T-0002", "helper"); // historical task owner without an installed profile
  writeDoc(P("decisions", "closed", "D-0001.md"), {
    id: "D-0001", agent: "reviewer", answered: older, answered_by: "owner(chat)",
    shadow_verdict: "decided", shadow_agree: "yes",
  }, "reviewed");

  const month = M.computeMetrics(30);
  const week = M.computeMetrics(7);
  expect(month.agents.reviewer.runs).toBe(1);
  expect(week.agents.reviewer).toBeUndefined();
  expect(week.shadow_judge_by_agent.reviewer).toEqual(month.shadow_judge_by_agent.reviewer);
  expect(week.shadow_judge_by_agent.reviewer).toMatchObject({ scored: 1, accuracy: 1 });
  expect(week.shadow_judge_by_agent.lead).toMatchObject({ scored: 0, accuracy: null });
  expect(week.shadow_judge_by_agent.helper).toMatchObject({ scored: 0, accuracy: null });
});

test("archived menus closed by a refresh have the same execution metrics as menus parked in rejected", () => {
  const agent = "chief-of-staff";
  const decision = "D-M0001";
  const replacement = "D-M0002";
  const footer = `> ${at(2)}: menu ${decision} superseded by ${replacement}; closed without running.`;
  const menu = { id: "T-M0001", agent, kind: "menu", decision, status: "done", started: at(600), finished: at(2) };
  const path = P("tasks", "done", "T-M0001.md");
  writeDoc(P("decisions", "closed", `${decision}.md`), {
    id: decision, task: menu.id, kind: "menu", answered_by: "system", answered: at(2), superseded_by: replacement,
  }, "refreshed");
  task("blocked", "T-M0002", agent, { started: at(5), finished: at(2) });
  task("rejected", "T-M0003", agent, { approval: "superseded:T-M0002" });
  writeDoc(path, menu, `old menu\n\n${footer}\n`);

  const metrics = M.computeMetrics(7);
  expect(metrics.agents[agent]).toEqual({ runs: 1, success: null, failed: 0, blocked: 1, median_minutes: 3 });
  expect(metrics.decisions.total).toBe(1);

  // A later completed run takes precedence over an old closure in the task's history.
  writeDoc(path, menu, `old menu\n\n${footer}\n\n## Run\n**done** — completed follow-up`);
  expect(M.computeMetrics(7).agents[agent].success).toBe(1);
});

// The blind spot that let 14 cards sit unanswered: this file counted only decisions/closed, so an owner who never
// answers reported as decisions.total = 0 — indistinguishable from a fleet that never had to ask anything.
test("cards still open are counted, with the age of the oldest one", () => {
  writeDoc(P("decisions", "open", "D-0001.md"), { id: "D-0001", created: new Date(Date.now() - 3 * 86400e3).toISOString() }, "q");
  writeDoc(P("decisions", "open", "D-0002.md"), { id: "D-0002", created: at(30) }, "q");
  const m = M.computeMetrics(7);
  expect(m.decisions.total).toBe(0);
  expect(m.decisions.open).toBe(2);
  expect(m.decisions.oldest_open_days).toBe(3);
});

// The numbers are only as good as the code that computed them. A host can report a healthy fleet while its daemon runs
// a checkout pinned 20+ commits back by local edits — every merged fix inert there, every figure from the old formula.
test("metrics say which code produced them, and when that code is behind or dirty", () => {
  const m = M.computeMetrics(7);
  expect(m.code?.commit).toMatch(/^[0-9a-f]{7,}$/);
  expect(m.code?.dirty_files).toBeGreaterThanOrEqual(0);

  // throwaway repo: one commit on main, origin/main one ahead, one uncommitted edit
  const dir = join(tmpdir(), `noop-code-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "ignore" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "1");
  g("add", "-A");
  g("commit", "-qm", "one");
  g("checkout", "-qb", "side");
  writeFileSync(join(dir, "a.txt"), "2");
  g("commit", "-qam", "two");
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), "dirty");
  const s = M.codeState(dir)!;
  expect(s.behind_origin).toBe(1);
  expect(s.dirty_files).toBe(1);
  expect(M.codeState(join(dir, "nope"))).toBeNull(); // no git checkout → null, not a false "clean"
  rmSync(dir, { recursive: true, force: true });
}, 120_000); // ~13 synchronous git spawns: 3 read the real checkout, 10 build the throwaway repo. Each runs 0.2-1 s on a
// busy Mac (load 60+ here) but 63.9 s in total at load 200-370, so the 30 s guard failed on load rather than on a
// regression — that blocked a daemon update.
