// Rejected-directory records include scheduler housekeeping and individual cancellations.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DATA, P, writeDoc } from "../src/core";
import { computeMetrics } from "../src/metrics";

if (!DATA.startsWith(tmpdir())) throw new Error(`refusing to run: DATA=${DATA} is not a temp dir`);
const clean = () => {
  for (const dir of ["tasks", "decisions", "fleet"]) rmSync(P(dir), { recursive: true, force: true });
};
beforeEach(() => { clean(); mkdirSync(P("fleet"), { recursive: true }); });
afterAll(clean);
const rejected = (id: string, meta: Record<string, string>) => writeDoc(P("tasks", "rejected", `${id}.md`), { id, ...meta }, "");
const decision = (id: string, answered_by: string) => writeDoc(P("decisions", "closed", `${id}.md`),
  { id, kind: "proposals", answered_by, answered: new Date().toISOString() }, "");

test("scheduler supersessions and cancelled tasks are not owner rejections", () => {
  for (let i = 1; i <= 17; i++) rejected(`T-${i}`, { approval: `superseded:T-${i + 1}` });
  rejected("T-18", { cancelled: new Date().toISOString() });
  const m = computeMetrics(30);
  expect(m.proposals_rejected_total).toBe(18);
  expect(m.rejected_task_reasons).toEqual({ scope: "all_retained_records", owner_rejected: 0, cancelled: 1, system_superseded: 17, unclassified: 0 });
  expect(JSON.parse(readFileSync(P("fleet", "metrics.json"), "utf8")).rejected_task_reasons).toEqual(m.rejected_task_reasons);
});

test("owner rejection requires a traceable owner-answered proposal decision", () => {
  decision("P-owner", "owner(chat)");
  decision("P-cli", "owner(cli@mac)");
  decision("P-system", "system");
  decision("P-judge", "judge");
  rejected("T-1", { approval: "rejected:P-owner" });
  rejected("T-2", { approval: "rejected:P-cli" });
  rejected("T-3", { approval: "rejected:P-system" });
  rejected("T-4", { approval: "rejected:P-judge" });
  rejected("T-5", { approval: "rejected:P-missing" });
  rejected("T-6", {});
  rejected("T-7", { approval: "rejected:P-owner", cancelled: new Date().toISOString() });
  const m = computeMetrics();
  expect(m.rejected_task_reasons).toEqual({ scope: "all_retained_records", owner_rejected: 2, cancelled: 1, system_superseded: 0, unclassified: 4 });
  expect(m.proposals_rejected_total).toBe(7);
});

test("retained rejection counts keep their explicit scope outside the requested window", () => {
  rejected("T-old", { approval: "superseded:T-new", created: "2000-01-01T00:00:00Z" });
  expect(computeMetrics(1).rejected_task_reasons.system_superseded).toBe(1);
  expect(computeMetrics(30).rejected_task_reasons.system_superseded).toBe(1);
  clean(); mkdirSync(P("fleet"), { recursive: true });
  expect(computeMetrics().rejected_task_reasons).toEqual({ scope: "all_retained_records", owner_rejected: 0, cancelled: 0, system_superseded: 0, unclassified: 0 });
});
