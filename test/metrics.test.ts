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
});
