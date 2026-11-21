// A refreshed next-steps menu replaces the unanswered one: D-0014 and D-0015 (same items, three hours apart) both
// stayed open overnight, and each further idle refresh would have added another card for the owner to answer.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DATA, P, precedents, readDoc, writeDoc } from "../src/core";
import { openDecision } from "../src/decisions";

const dirs = ["tasks/blocked", "tasks/done", "tasks/inbox", "decisions/open", "decisions/closed"];
beforeEach(() => {
  if (!DATA.startsWith(tmpdir())) throw new Error(`Refusing to use live DATA: ${DATA}`);
  for (const d of dirs) { rmSync(P(d), { recursive: true, force: true }); mkdirSync(P(d), { recursive: true }); }
});
afterAll(() => { for (const d of dirs) rmSync(P(d), { recursive: true, force: true }); });

const res = (q: string) => ({ status: "needs_decision", summary: "ctx", question: q, recommendation: "1", options: ["1. a", "2. b"] } as any);
const blocked = (id: string, kind = "menu") => writeDoc(P("tasks", "blocked", `${id}.md`), { id, agent: "chief-of-staff", kind }, "body");

test("a new menu card closes the older unanswered menu and finishes its task without running it", () => {
  blocked("T-0014");
  const old = openDecision({ id: "T-0014", agent: "chief-of-staff", kind: "menu" }, res("选哪几项执行？"), "h");
  blocked("T-0015");
  const fresh = openDecision({ id: "T-0015", agent: "chief-of-staff", kind: "menu" }, res("选哪几项执行？"), "h");

  expect(existsSync(P("decisions", "open", `${fresh}.md`))).toBe(true);
  expect(existsSync(P("decisions", "open", `${old}.md`))).toBe(false);
  const closed = readDoc(P("decisions", "closed", `${old}.md`)).meta;
  expect(closed.answered_by).toBe("system");
  expect(closed.superseded_by).toBe(fresh);
  // the old menu task is finished, not resumed into the inbox (resuming would let the agent pick items itself)
  expect(existsSync(P("tasks", "blocked", "T-0014.md"))).toBe(false);
  expect(existsSync(P("tasks", "inbox", "T-0014.md"))).toBe(false);
  expect(readDoc(P("tasks", "done", "T-0014.md")).meta.status).toBe("done");
  // the new menu's own task is untouched
  expect(existsSync(P("tasks", "blocked", "T-0015.md"))).toBe(true);
  // a superseded card is not an owner answer: it is not offered to agents or the judge as a precedent
  expect(precedents()).not.toContain(old);
});

test("ordinary decisions and the same task asking again are left alone", () => {
  blocked("T-0020", "");
  const plain = openDecision({ id: "T-0020", agent: "lead" }, res("Merge?"), "h");
  blocked("T-0021");
  const m1 = openDecision({ id: "T-0021", agent: "chief-of-staff", kind: "menu" }, res("选哪几项执行？"), "h");
  const again = openDecision({ id: "T-0021", agent: "chief-of-staff", kind: "menu" }, res("选哪几项执行？"), "h");

  expect(again).toBe(m1);
  expect(existsSync(P("decisions", "open", `${m1}.md`))).toBe(true);
  expect(existsSync(P("decisions", "open", `${plain}.md`))).toBe(true);
  expect(existsSync(P("tasks", "blocked", "T-0020.md"))).toBe(true);
});
