// Fleet metrics: `blocked/` holds tasks parked on the owner's decision, not agent failures.
// Counting them as failures understates success and corrupts the numbers the architect uses to graduate an agent.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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
